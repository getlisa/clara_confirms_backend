const db = require("../db");
const callSettingsDb = require("../db/call-settings");
const callTriggerConfigsDb = require("../db/call-trigger-configs");
const callTypeConfigsDb = require("../db/call-type-configs");
const scheduledCallsDb = require("../db/scheduled-calls");
const todosDb = require("../db/todos");
const { computeInitialPriority } = require("./call-priority");
const { resolveOutboundChannel } = require("./channel-resolver");
const retell = require("./retell");
const chatLinksService = require("./chat-links");
const chatLinkEmail = require("./chat-link-email");
const chatLinkSms = require("./chat-link-sms");
const logger = require("../utils/logger");

const isDev = process.env.NODE_ENV === "development";

// ── Time helpers (re-exported from ./office-hours for back-compat) ───────────
const officeHours = require("./office-hours");
const { toLocalHHMM, toLocalDayOfWeek, isWithinActiveHours, getNextWindowStart,
        snapToWindowStart, formatDateInTz } = officeHours;

// ── Dispatcher ────────────────────────────────────────────────────────────────

/**
 * Run the dispatcher to fire due scheduled_calls.
 *
 * @param {number} batchSize
 * @param {object} opts
 * @param {number} [opts.companyId]     — scope to one company (manual UI trigger)
 * @param {boolean} [opts.respectAutoFlag=true]
 *                                       — when true (system cron), skip rows belonging
 *                                         to companies with auto_dispatch_enabled=false.
 *                                         when false (manual UI), fire regardless.
 */
async function runDispatcher(batchSize = 10, { companyId = null, respectAutoFlag = true } = {}) {
  const scopeFilter = companyId ? "AND sc.company_id = $1" : "";
  const autoFilter  = respectAutoFlag
    ? `AND EXISTS (
         SELECT 1 FROM call_settings cs
         WHERE cs.company_id = sc.company_id AND cs.auto_dispatch_enabled = true
       )`
    : "";
  const params = companyId ? [companyId] : [];

  // Log every pending call and why it is/isn't being picked up this run
  const { rows: allPending } = await db.query(
    `SELECT sc.id, sc.call_type, sc.job_id, sc.job_name, sc.customer_name, sc.phone_number,
            sc.scheduled_at, sc.is_test, sc.status, sc.attempt_number, sc.max_attempts,
            sc.company_id,
            sc.scheduled_at <= NOW() AS due
     FROM scheduled_calls sc
     WHERE sc.status = 'pending'
       ${scopeFilter}
       ${autoFilter}
     ORDER BY sc.scheduled_at ASC`,
    params
  );

  if (allPending.length === 0) {
    logger.info("Dispatcher: no pending calls in queue");
  } else {
    logger.info(`Dispatcher: ${allPending.length} pending call(s) in queue`);
    for (const r of allPending) {
      if (r.due) {
        logger.info("Dispatcher: call is due — will attempt", {
          rowId: r.id, callType: r.call_type, jobId: r.job_id, jobName: r.job_name,
          customer: r.customer_name, scheduledAt: r.scheduled_at, attempt: r.attempt_number,
        });
      } else {
        const secsUntilDue = Math.round((new Date(r.scheduled_at) - Date.now()) / 1000);
        const minsUntilDue = Math.ceil(secsUntilDue / 60);
        logger.info("Dispatcher: call not due yet — skipping this run", {
          rowId: r.id, callType: r.call_type, jobId: r.job_id, jobName: r.job_name,
          customer: r.customer_name, scheduledAt: r.scheduled_at,
          reason: `scheduled_at is ${minsUntilDue} min in the future`,
        });
      }
    }
  }

  const rows = await scheduledCallsDb.claimPending(batchSize, { companyId, respectAutoFlag });
  if (rows.length === 0) {
    logger.info("Dispatcher: no due calls to process");
    return { fired: 0, skipped: 0, failed: 0 };
  }

  logger.info(`Dispatcher: claimed ${rows.length} due call(s) for processing`);
  let fired = 0, skipped = 0, failed = 0;

  for (const row of rows) {
    const ctx = {
      rowId: row.id,
      callType: row.call_type,
      jobId: row.job_id,
      jobName: row.job_name,
      customer: row.customer_name,
      phone: row.phone_number,
      scheduledAt: row.scheduled_at,
      isTest: row.is_test,
      attempt: row.attempt_number,
    };

    try {
      const { rows: cr } = await db.query(`SELECT default_timezone FROM companies WHERE id = $1`, [row.company_id]);
      const tz = cr[0]?.default_timezone || "America/New_York";

      // In production: check office hours and reschedule if outside window
      if (!isDev) {
        const cs = await callSettingsDb.getByCompanyId(row.company_id);
        if (!isWithinActiveHours(cs, tz)) {
          const nextWindow = getNextWindowStart(cs, tz);
          await scheduledCallsDb.advanceToNextWindow(row.id, nextWindow);
          logger.info("Dispatcher: skipped — outside office hours", {
            ...ctx,
            reason: `Current time is outside business hours (${cs.business_hours_start}–${cs.business_hours_end} ${tz})`,
            rescheduledTo: nextWindow,
          });
          skipped++; continue;
        }
      }

      const now = new Date();
      const callTz = tz;
      const dynVars = {
        call_type:    row.call_type,
        current_date: now.toLocaleDateString("en-US", { timeZone: callTz, weekday: "long", year: "numeric", month: "long", day: "numeric" }),
        current_time: now.toLocaleTimeString("en-US", { timeZone: callTz, hour: "2-digit", minute: "2-digit", hour12: true }),
        ...(row.customer_name    && { customer_name:    row.customer_name }),
        ...(row.technician_name  && { technician_name:  row.technician_name }),
        ...(row.customer_address && { customer_address: row.customer_address }),
        ...(row.job_date && { job_date: new Date(row.job_date).toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", year:"numeric" }) }),
        ...(row.job_id          && { job_id:          String(row.job_id) }),
        ...(row.appointment_id  && { appointment_id:  String(row.appointment_id) }),
        ...(row.job_name        && { job_name:        row.job_name }),
        ...(row.job_description && { job_description: row.job_description }),
        ...(row.job_type        && { job_type:        row.job_type }),
        ...(row.total_amount != null && { total_amount: String(row.total_amount) }),
        // Extra per-call context (e.g. service_opportunities, service_opportunity_count,
        // location_name, location_address) for call types that carry more than the flat
        // single-job columns. Values are already-stringified in call_context.
        ...(row.call_context && typeof row.call_context === "object" ? row.call_context : {}),
      };

      // Resolve call-type-specific voicemail message with actual values
      const callTypeCfg = await callTypeConfigsDb.getByType(row.company_id, row.call_type);
      const vmTemplate = callTypeCfg?.voicemail_message
        || callTypeConfigsDb.generateDefaultVoicemailMessage(row.call_type);
      const { rows: coRows } = await db.query(
        `SELECT c.name AS company_name, a.representative_name
         FROM companies c LEFT JOIN agent_settings a ON a.company_id = c.id WHERE c.id = $1`,
        [row.company_id]
      );
      const co = coRows[0] || {};
      const voicemailMessage = vmTemplate
        .replace(/\{\{customer_name\}\}/g,      row.customer_name   || "")
        .replace(/\{\{technician_name\}\}/g,     row.technician_name || "")
        .replace(/\{\{representative_name\}\}/g, co.representative_name || "Clara")
        .replace(/\{\{company_name\}\}/g,        co.company_name || "our company")
        .replace(/\{\{location_name\}\}/g,       (row.call_context && row.call_context.location_name) || "your location");

      if (row.channel === "web_chat") {
        // One shared chat_links token, delivered by email and/or SMS per
        // chat_link_delivery_method — a plain text with a link, same idea as
        // the email. Same underlying mechanism the plain "sms" channel now
        // uses too (below) — retell_call_id stays null until the customer
        // actually opens the link, regardless of medium.
        const deliveryMethod = (await callSettingsDb.getByCompanyId(row.company_id)).chat_link_delivery_method;

        // A manually-supplied email/phone (e.g. the "Email Now" button, when
        // the customer record itself has none — the common case for
        // ServiceTrade-synced customers, whose email lives on a separate
        // Contact, not synced here) travels through call_context since this
        // dispatch step re-reads the row from the DB and has no other way to
        // see it.
        const overrideEmail = row.call_context?.override_email || null;
        const overridePhone = row.call_context?.override_phone || null;
        const { rows: custRows } = await db.query(
          `SELECT c.email, c.phone FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = $1 AND j.company_id = $2`,
          [row.job_id, row.company_id]
        );
        const customerEmail = overrideEmail || custRows[0]?.email || null;
        const customerPhone = overridePhone || custRows[0]?.phone || null;

        const wantEmail = deliveryMethod === "email" || deliveryMethod === "both";
        const wantSms = deliveryMethod === "sms" || deliveryMethod === "both";

        // Contact-completeness is normally checked before the row is even
        // created (processScheduledUnconfirmed) — these only fire if contact
        // info was removed in between scheduling and dispatch.
        if (deliveryMethod === "email" && !customerEmail) {
          throw new Error("Customer email no longer on file — cannot dispatch web_chat confirmation");
        }
        if (deliveryMethod === "sms" && !customerPhone) {
          throw new Error("Customer phone no longer on file — cannot dispatch web_chat confirmation");
        }
        if (deliveryMethod === "both" && !customerEmail && !customerPhone) {
          throw new Error("Customer has no email or phone on file — cannot dispatch web_chat confirmation");
        }

        const linkResult = row.appointment_id
          ? await chatLinksService.createChatLinkForAppointment(row.company_id, row.appointment_id, row.call_type)
          : await chatLinksService.createChatLinkForJob(row.company_id, row.job_id, row.call_type);
        if (!linkResult.ok) throw new Error(linkResult.error || "Failed to create chat link");

        // Each leg is caught independently — for 'both', one leg throwing
        // must NOT cause the whole row to retry, since a retry would
        // re-send whichever leg already succeeded (e.g. re-emailing the
        // customer while only the sms leg actually needs another attempt).
        let emailSent = false, smsSent = false, emailError = null, smsError = null;

        if (wantEmail && customerEmail) {
          try {
            await chatLinkEmail.sendConfirmationLinkEmail({
              email: customerEmail,
              customerName: row.customer_name,
              companyName: co.company_name || "our company",
              jobName: row.job_name,
              token: linkResult.token,
            });
            emailSent = true;
          } catch (err) {
            emailError = err;
          }
        } else if (wantEmail) {
          logger.warn("Dispatcher: chat_link_delivery_method wants email but customer has none — sending sms only", { ...ctx });
        }

        if (wantSms && customerPhone) {
          try {
            await chatLinkSms.sendConfirmationLinkSms({
              phone: customerPhone,
              customerName: row.customer_name,
              companyName: co.company_name || "our company",
              jobName: row.job_name,
              token: linkResult.token,
            });
            smsSent = true;
          } catch (err) {
            smsError = err;
          }
        } else if (wantSms) {
          logger.warn("Dispatcher: chat_link_delivery_method wants sms but customer has no phone — sending email only", { ...ctx });
        }

        // Single-method modes: propagate the sole leg's error as-is so the
        // existing retry/max-attempts machinery handles it (safe — nothing
        // else was sent this attempt). 'both': only propagate (and thus
        // retry) if NEITHER leg went out; if exactly one succeeded, mark
        // completed with the shared link and flag the failed leg instead of
        // risking a duplicate send on retry.
        if (deliveryMethod !== "both") {
          if (emailError) throw emailError;
          if (smsError) throw smsError;
        } else if (!emailSent && !smsSent) {
          throw emailError || smsError || new Error("web_chat 'both' dispatch failed on both legs");
        } else if (emailError || smsError) {
          logger.warn("Dispatcher: web_chat 'both' partially failed — one leg succeeded, not retrying to avoid duplicate send", {
            ...ctx, emailError: emailError?.message, smsError: smsError?.message,
          });
        }

        await scheduledCallsDb.markCompletedWithChatLink(row.id, linkResult.token);
        logger.info("Dispatcher: fired (web_chat)", { ...ctx, deliveryMethod, token: linkResult.token, emailSent, smsSent });
        fired++;
        continue;
      }

      if (row.channel === "sms") {
        // Texts the same chat_links confirmation link used by web_chat/sms —
        // NOT a live Retell agent<->customer conversation. We've stopped
        // using Retell's conversational SMS (createSmsChat) for confirmations
        // for now; retell.createSmsChat is left defined, just unused, in
        // case this needs to be re-enabled later.
        const linkResult = row.appointment_id
          ? await chatLinksService.createChatLinkForAppointment(row.company_id, row.appointment_id, row.call_type)
          : await chatLinksService.createChatLinkForJob(row.company_id, row.job_id, row.call_type);
        if (!linkResult.ok) throw new Error(linkResult.error || "Failed to create chat link");

        await chatLinkSms.sendConfirmationLinkSms({
          phone: row.phone_number,
          customerName: row.customer_name,
          companyName: co.company_name || "our company",
          jobName: row.job_name,
          token: linkResult.token,
        });

        await scheduledCallsDb.markCompletedWithChatLink(row.id, linkResult.token);
        logger.info("Dispatcher: fired (sms-link)", { ...ctx, channel: row.channel, token: linkResult.token });
        fired++;
        continue;
      }

      const call = await retell.createCall({
        toNumber: row.phone_number,
        companyId: row.company_id,
        callType: row.call_type,
        dynamicVariables: dynVars,
        metadata: { scheduled_call_id: String(row.id), is_test: row.is_test },
        voicemailMessage,
      });
      const externalId = call.call_id;
      await scheduledCallsDb.markCompleted(row.id, externalId);
      logger.info("Dispatcher: fired", { ...ctx, channel: row.channel, retellCallId: externalId });
      fired++;
    } catch (err) {
      const st = await scheduledCallsDb.markFailedOrRetry(row.id, err.message);
      logger.error("Dispatcher: failed to fire call", {
        ...ctx,
        error: err.message,
        newStatus: st,
        reason: st === "failed"
          ? `Exceeded max attempts (${row.max_attempts})`
          : `Will retry in X minutes (attempt ${row.attempt_number + 1}/${row.max_attempts})`,
      });
      failed++;
    }
  }

  logger.info("Dispatcher: run complete", { fired, skipped, failed });
  return { fired, skipped, failed };
}

// ── Daily job ─────────────────────────────────────────────────────────────────

/**
 * Run the daily scheduling job.
 *
 * @param {object} opts
 * @param {number} [opts.companyId]      — scope to one company (manual trigger from UI)
 * @param {boolean} [opts.respectAutoFlag=true]
 *                                       — when true (system cron), skip companies where
 *                                         call_settings.auto_schedule_enabled = false.
 *                                         when false (manual trigger), ignore the flag.
 */
async function runDailyJob({ companyId = null, respectAutoFlag = true, engine = null } = {}) {
  const env = isDev ? "development" : "production";
  const mode = companyId ? `manual (company ${companyId})` : "cron";
  logger.info(`Daily job: started (${env} mode, ${mode})`);

  const { rows: companies } = await db.query(
    companyId
      ? `SELECT id, default_timezone, sms_status FROM companies WHERE id = $1 AND (is_active = true OR is_active IS NULL)`
      : `SELECT id, default_timezone, sms_status FROM companies WHERE is_active = true OR is_active IS NULL`,
    companyId ? [companyId] : []
  );
  logger.info(`Daily job: processing ${companies.length} company(ies)`);

  let created = 0, skipped = 0;

  for (const co of companies) {
    try {
      const cs = await callSettingsDb.getByCompanyId(co.id);

      // System cron respects the per-company auto-schedule toggle.
      // Manual triggers bypass it.
      if (respectAutoFlag && cs.auto_schedule_enabled === false) {
        logger.info("Daily job: skipped company — auto_schedule_enabled=false", { companyId: co.id });
        continue;
      }

      // Independent of trigger config — falls unopened chat-link confirmations
      // back to voice regardless of which trigger originally scheduled them.
      try {
        const { fallenBack } = await processUnopenedChatLinks(co.id);
        if (fallenBack > 0) {
          logger.info("Daily job: unopened chat links fell back to voice", { companyId: co.id, fallenBack });
        }
      } catch (err) {
        logger.error("Daily job: unopened chat-link watchdog error", { companyId: co.id, error: err.message });
      }

      const triggers = await callTriggerConfigsDb.getEnabledByCompanyId(co.id);
      if (triggers.length === 0) {
        logger.info("Daily job: skipped company — no enabled triggers", { companyId: co.id });
        continue;
      }
      const tz = co.default_timezone || "America/New_York";
      const smsLive = co.sms_status === "live";
      logger.info(`Daily job: company has ${triggers.length} enabled trigger(s)`, {
        companyId: co.id, tz, smsLive, triggers: triggers.map(t => t.trigger_type),
      });

      for (const trigger of triggers) {
        try {
          if (engine) await engine.transition("running_trigger", { trigger_type: trigger.trigger_type, company_id: co.id });
          const { c, s } = await processTrigger(co.id, trigger, cs, tz, smsLive);
          created += c; skipped += s;
          if (engine) await engine.emit("trigger_done", { trigger_type: trigger.trigger_type, company_id: co.id, scheduled: c, skipped: s });
          logger.info(`Daily job: trigger processed`, {
            companyId: co.id, trigger: trigger.trigger_type, created: c, skipped: s,
          });
        } catch (err) {
          if (engine) await engine.emit("trigger_error", { trigger_type: trigger.trigger_type, company_id: co.id, error: err.message });
          logger.error("Daily job: trigger error", { companyId: co.id, trigger: trigger.trigger_type, error: err.message });
        }
      }
    } catch (err) {
      logger.error("Daily job: company error", { companyId: co.id, error: err.message });
    }
  }

  logger.info("Daily job: complete", { created, skipped, env });
  return { created, skipped };
}

// ── Trigger processors ────────────────────────────────────────────────────────

async function scheduleCall(params) {
  try {
    await scheduledCallsDb.create(params);
    logger.info("Scheduler: call queued", {
      companyId: params.companyId,
      callType: params.callType,
      jobId: params.jobId,
      jobName: params.jobName,
      customer: params.customerName,
      technician: params.technicianName,
      phone: params.phoneNumber,
      scheduledAt: params.scheduledAt,
      isTest: params.isTest,
    });
    return true;
  } catch (err) {
    if (err.code === "DUPLICATE_SCHEDULED_CALL" || err.code === "23505") return false;
    throw err;
  }
}

// A web_chat confirmation whose link has sat unopened this long is treated
// as the "no answer" equivalent — there's no chat_ended/chat_analyzed webhook
// to react to if the customer never opened it at all, so this can't reuse the
// existing webhook-driven retry path and instead falls back to voice.
const CHAT_LINK_UNOPENED_WINDOW_HOURS = 48;

async function processUnopenedChatLinks(companyId) {
  const { rows } = await db.query(
    `SELECT sc.id, sc.job_id, sc.appointment_id, sc.call_type, sc.customer_name,
            sc.job_name, sc.job_description, sc.job_type, sc.job_date,
            sc.is_test, sc.max_attempts, sc.phone_number
     FROM scheduled_calls sc
     JOIN chat_links cl ON cl.token = sc.chat_link_token
     WHERE sc.company_id = $1
       AND sc.channel IN ('web_chat', 'sms')
       AND sc.status = 'completed'
       AND sc.chat_link_token IS NOT NULL
       AND cl.retell_chat_id IS NULL
       AND sc.updated_at < NOW() - INTERVAL '${CHAT_LINK_UNOPENED_WINDOW_HOURS} hours'`,
    [companyId]
  );

  let fallenBack = 0;
  for (const row of rows) {
    const jobId = String(row.job_id);
    if (await scheduledCallsDb.existsForCustomerJob(companyId, jobId, row.call_type, row.is_test)) {
      logger.info("Scheduler [unopened_chat_link]: skipped — a call already exists for this job", { companyId, jobId });
      continue;
    }

    const inserted = await scheduleCall({
      companyId, callType: row.call_type,
      phoneNumber: row.phone_number,
      jobId, jobDate: row.job_date,
      appointmentId: row.appointment_id || null,
      customerName: row.customer_name,
      jobName: row.job_name || null,
      jobDescription: row.job_description || null,
      jobType: row.job_type || null,
      scheduledAt: new Date(), isTest: row.is_test, maxAttempts: row.max_attempts,
      callPriority: "retry",
      channel: "voice",
    });
    if (!inserted) continue;

    await db.query(
      `UPDATE scheduled_calls SET status = 'failed', failure_reason = 'chat_link_unopened', updated_at = NOW() WHERE id = $1`,
      [row.id]
    );
    logger.info("Scheduler [unopened_chat_link]: fell back to voice", { companyId, jobId, scheduledCallId: row.id });
    fallenBack++;
  }
  return { fallenBack };
}

async function processTrigger(companyId, trigger, callSettings, tz, smsLive = false) {
  switch (trigger.trigger_type) {
    case "scheduled_unconfirmed":  return processScheduledUnconfirmed(companyId, trigger, callSettings, tz, smsLive);
    case "quotation_pending":      return processQuotationPending(companyId, trigger, callSettings, tz, smsLive);
    case "open_job_due_soon":      return processOpenJobDueSoon(companyId, trigger, callSettings, tz, smsLive);
    // technician_unconfirmed dials the technician, not the end customer — voice only, out of scope.
    case "technician_unconfirmed": return processTechnicianUnconfirmed(companyId, trigger, callSettings, tz);
    default: return { c: 0, s: 0 };
  }
}

/**
 * Dev:  schedule NOW+5min, is_test=true, match any upcoming unconfirmed appointment
 * Prod: schedule at business-hours window N days from now, is_test=false
 */
async function processScheduledUnconfirmed(companyId, trigger, callSettings, tz, smsLive = false) {
  // Window match: any appointment whose date (in company tz) is within
  // [today, today + days_before]. Catches jobs created late and any day the cron missed.
  const todayStr = formatDateInTz(new Date(), tz);
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + trigger.days_before);
  const endDateStr = formatDateInTz(endDate, tz);
  const targetDate = new Date(endDateStr);

  const dateFilter = isDev
    ? "a.scheduled_start >= NOW()"
    : "DATE(a.scheduled_start AT TIME ZONE $2) BETWEEN $3::date AND $4::date";
  const params = isDev ? [companyId] : [companyId, tz, todayStr, endDateStr];

  // Include both scheduled and rescheduled jobs/appointments — both still need
  // customer confirmation. A rescheduled appointment is the new time the customer
  // must confirm.
  const { rows } = await db.query(
    `SELECT DISTINCT ON (j.id)
            j.id AS job_id, j.scheduled_date, j.status AS job_status,
            j.title AS job_name, j.description AS job_description, j.job_type,
            a.id AS appointment_id, a.status AS appointment_status,
            c.phone AS customer_phone, c.email AS customer_email, c.full_name AS customer_name,
            c.address_line1, c.city, c.state, c.preferred_channel
     FROM jobs j
     JOIN appointments a ON a.job_id = j.id AND a.status IN ('scheduled','rescheduled')
     JOIN customers c ON c.id = j.customer_id
     WHERE j.company_id = $1
       AND j.status IN ('scheduled','rescheduled')
       AND (a.customer_confirmed IS NULL OR a.customer_confirmed = false)
       AND ${dateFilter}
     ORDER BY j.id, a.scheduled_start ASC`,
    params
  );

  logger.info(`Scheduler [scheduled_unconfirmed]: found ${rows.length} unconfirmed appointment(s)`, { companyId, window: `${todayStr} to ${endDateStr}` });

  let c = 0, s = 0;
  for (const row of rows) {
    const jobId = String(row.job_id);

    // Channel must be resolved before the contact-completeness gate below —
    // resolveOutboundChannel only depends on settings/preferences, never on
    // contact info, so this ordering is always safe. (Previously the phone
    // check ran unconditionally first, which would incorrectly block a
    // web_chat/email-delivery customer who has an email but no phone on file.)
    const channel = resolveOutboundChannel({
      smsLive, preferredChannel: row.preferred_channel,
      channelStrategy: callSettings.channel_strategy, attemptNumber: 1,
    });

    if (channel !== "web_chat" && !row.customer_phone) {
      await todosDb.createMissingPhone({
        companyId, jobId, subjectKind: "customer",
        subjectName: row.customer_name, callType: trigger.call_type,
        reason: "Customer phone number not provided — confirmation call could not be placed.",
        isTest: isDev,
      });
      logger.info("Scheduler [scheduled_unconfirmed]: todo created — customer missing phone", { companyId, jobId, customer: row.customer_name });
      s++; continue;
    }

    // Contact-completeness gate for web_chat — required contact info depends
    // on the company's configured chat_link_delivery_method ('email' sends a
    // link by email; 'sms' starts a live Retell conversation over text, same
    // mechanism as the "Text Now" channel, so it needs a phone; 'both' needs
    // at least one). Flag missing info for staff instead of silently skipping
    // or guessing another channel; the next sweep picks it up normally once
    // the missing info is added.
    if (channel === "web_chat") {
      const deliveryMethod = callSettings.chat_link_delivery_method;
      const needsEmail = deliveryMethod === "email" && !row.customer_email;
      const needsPhone = deliveryMethod === "sms" && !row.customer_phone;
      const needsEither = deliveryMethod === "both" && !row.customer_email && !row.customer_phone;

      if (needsEmail || needsEither) {
        await todosDb.createMissingEmail({
          companyId, jobId, subjectKind: "customer",
          subjectName: row.customer_name, callType: trigger.call_type,
          reason: "Customer email not provided — confirmation chat link could not be sent.",
          isTest: isDev,
        });
        logger.info("Scheduler [scheduled_unconfirmed]: todo created — customer missing email for web_chat dispatch", { companyId, jobId, customer: row.customer_name });
        s++; continue;
      }
      if (needsPhone) {
        await todosDb.createMissingPhone({
          companyId, jobId, subjectKind: "customer",
          subjectName: row.customer_name, callType: trigger.call_type,
          reason: "Customer phone number not provided — confirmation chat could not be texted.",
          isTest: isDev,
        });
        logger.info("Scheduler [scheduled_unconfirmed]: todo created — customer missing phone for web_chat dispatch", { companyId, jobId, customer: row.customer_name });
        s++; continue;
      }
    }

    if (await scheduledCallsDb.existsForCustomerJob(companyId, jobId, trigger.call_type, isDev)) {
      logger.info("Scheduler [scheduled_unconfirmed]: skipped — call already exists", {
        companyId, jobId, jobName: row.job_name, customer: row.customer_name,
        reason: "Active or completed scheduled call already exists for this job",
      });
      s++; continue;
    }

    const scheduledAt = isDev
      ? new Date()
      : snapToWindowStart(callSettings, tz, new Date());

    const inserted = await scheduleCall({
      companyId, callType: trigger.call_type,
      phoneNumber: row.customer_phone,
      jobId, jobDate: targetDate,
      appointmentId: row.appointment_id || null,
      customerName: row.customer_name,
      customerAddress: [row.address_line1, row.city, row.state].filter(Boolean).join(", ") || null,
      jobName: row.job_name || null,
      jobDescription: row.job_description || null,
      jobType: row.job_type || null,
      scheduledAt, isTest: isDev, maxAttempts: callSettings.max_attempts,
      callPriority: computeInitialPriority({ triggerType: "scheduled_unconfirmed", jobDate: targetDate, tz }),
      channel,
    });
    if (inserted) c++; else {
      logger.info("Scheduler [scheduled_unconfirmed]: skipped — duplicate on insert", { companyId, jobId });
      s++;
    }
  }
  return { c, s };
}

async function processQuotationPending(companyId, trigger, callSettings, tz, smsLive = false) {
  const cfg = trigger.trigger_config;
  const quoteStatuses = cfg.quote_statuses ?? ["sent", "viewed"];
  const daysAfterSent = cfg.days_after_sent ?? 3;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysAfterSent);

  const { rows } = await db.query(
    `SELECT q.id AS quotation_id, q.job_id, q.title AS quote_title, q.notes AS quote_description,
            q.total_amount, q.currency,
            c.phone AS customer_phone, c.full_name AS customer_name, c.preferred_channel
     FROM quotations q
     JOIN customers c ON c.id = q.customer_id
     WHERE q.company_id = $1
       AND q.status = ANY($2::varchar[])
       AND q.created_at <= $3
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.id = q.job_id AND j.status = 'completed'
       )
       AND NOT EXISTS (
         SELECT 1 FROM appointments a
         JOIN jobs j ON j.id = a.job_id
         WHERE j.id = q.job_id AND a.status = 'completed'
       )`,
    [companyId, quoteStatuses, cutoff.toISOString()]
  );

  logger.info(`Scheduler [quotation_pending]: found ${rows.length} eligible quotation(s) (excludes completed jobs/appointments)`, { companyId, cutoff: cutoff.toISOString() });

  let c = 0, s = 0;
  for (const row of rows) {
    const jobId = scheduledCallsDb.quotationJobId(row.quotation_id);
    if (!row.customer_phone) {
      await todosDb.createMissingPhone({
        companyId, jobId: row.job_id || jobId, subjectKind: "customer",
        subjectName: row.customer_name, callType: trigger.call_type,
        reason: "Customer phone number not provided — quotation follow-up call could not be placed.",
        metadata: { quotation_id: row.quotation_id },
        isTest: isDev,
      });
      logger.info("Scheduler [quotation_pending]: todo created — customer missing phone", { companyId, quotationId: row.quotation_id, customer: row.customer_name });
      s++; continue;
    }
    if (await scheduledCallsDb.existsForQuotation(companyId, row.quotation_id, row.job_id, trigger.call_type, isDev)) {
      logger.info("Scheduler [quotation_pending]: skipped — call already exists", {
        companyId, quotationId: row.quotation_id, jobName: row.quote_title, customer: row.customer_name,
        reason: "Active or completed scheduled call already exists for this quotation",
      });
      s++; continue;
    }

    const scheduledAt = isDev
      ? new Date()
      : getNextWindowStart(callSettings, tz);

    const channel = resolveOutboundChannel({
      smsLive, preferredChannel: row.preferred_channel,
      channelStrategy: callSettings.channel_strategy, attemptNumber: 1,
    });

    const inserted = await scheduleCall({
      companyId, callType: trigger.call_type,
      phoneNumber: row.customer_phone,
      jobId, jobDate: null,
      customerName: row.customer_name,
      jobName: row.quote_title || null,
      jobDescription: row.quote_description || null,
      totalAmount: row.total_amount ?? null,
      scheduledAt, isTest: isDev, maxAttempts: callSettings.max_attempts,
      callPriority: computeInitialPriority({ triggerType: "quotation_pending", jobDate: null, tz }),
      channel,
    });
    if (inserted) c++; else {
      logger.info("Scheduler [quotation_pending]: skipped — duplicate on insert", { companyId, quotationId: row.quotation_id });
      s++;
    }
  }
  return { c, s };
}

async function processOpenJobDueSoon(companyId, trigger, callSettings, tz, smsLive = false) {
  const todayStr = formatDateInTz(new Date(), tz);
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + trigger.days_before);
  const endDateStr = formatDateInTz(endDate, tz);
  const cfg = trigger.trigger_config;
  const targetDate = new Date(endDateStr);

  // Window: today through today + days_before (inclusive)
  const dateClause = isDev
    ? "j.scheduled_date >= CURRENT_DATE"
    : "j.scheduled_date BETWEEN $2::date AND $3::date";

  let query = `
    SELECT j.id AS job_id, j.scheduled_date,
           j.title AS job_name, j.description AS job_description, j.job_type,
           c.phone AS customer_phone, c.full_name AS customer_name,
           c.address_line1, c.city, c.state, c.preferred_channel
    FROM jobs j
    JOIN customers c ON c.id = j.customer_id
    WHERE j.company_id = $1
      AND j.status = 'open'
      AND ${dateClause}
      AND NOT EXISTS (
        SELECT 1 FROM appointments ap
        WHERE ap.job_id = j.id AND ap.status NOT IN ('cancelled')
      )`;

  if (cfg.only_if_technician_assigned) query += " AND j.technician_id IS NOT NULL";

  const { rows } = await db.query(query, isDev ? [companyId] : [companyId, todayStr, endDateStr]);

  logger.info(`Scheduler [open_job_due_soon]: found ${rows.length} open job(s) due soon`, { companyId, window: `${todayStr} to ${endDateStr}` });

  let c = 0, s = 0;
  for (const row of rows) {
    const jobId = String(row.job_id);
    if (!row.customer_phone) {
      await todosDb.createMissingPhone({
        companyId, jobId, subjectKind: "customer",
        subjectName: row.customer_name, callType: trigger.call_type,
        reason: "Customer phone number not provided — due-soon job confirmation could not be placed.",
        isTest: isDev,
      });
      logger.info("Scheduler [open_job_due_soon]: todo created — customer missing phone", { companyId, jobId, customer: row.customer_name });
      s++; continue;
    }
    if (await scheduledCallsDb.existsForCustomerJob(companyId, jobId, trigger.call_type, isDev)) {
      logger.info("Scheduler [open_job_due_soon]: skipped — call already exists", {
        companyId, jobId, jobName: row.job_name, customer: row.customer_name,
        reason: "Active or completed scheduled call already exists for this job",
      });
      s++; continue;
    }

    const scheduledAt = isDev
      ? new Date()
      : snapToWindowStart(callSettings, tz, new Date());

    const channel = resolveOutboundChannel({
      smsLive, preferredChannel: row.preferred_channel,
      channelStrategy: callSettings.channel_strategy, attemptNumber: 1,
    });

    const inserted = await scheduleCall({
      companyId, callType: trigger.call_type,
      phoneNumber: row.customer_phone,
      jobId, jobDate: targetDate,
      customerName: row.customer_name,
      customerAddress: [row.address_line1, row.city, row.state].filter(Boolean).join(", ") || null,
      jobName: row.job_name || null,
      jobDescription: row.job_description || null,
      jobType: row.job_type || null,
      scheduledAt, isTest: isDev, maxAttempts: callSettings.max_attempts,
      callPriority: computeInitialPriority({ triggerType: "open_job_due_soon", jobDate: targetDate, tz }),
      channel,
    });
    if (inserted) c++; else {
      logger.info("Scheduler [open_job_due_soon]: skipped — duplicate on insert", { companyId, jobId });
      s++;
    }
  }
  return { c, s };
}

async function processTechnicianUnconfirmed(companyId, trigger, callSettings, tz) {
  const todayStr = formatDateInTz(new Date(), tz);
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + trigger.days_before);
  const endDateStr = formatDateInTz(endDate, tz);
  const targetDate = new Date(endDateStr);

  const dateFilter = isDev
    ? "a.scheduled_start >= NOW()"
    : "DATE(a.scheduled_start AT TIME ZONE $2) BETWEEN $3::date AND $4::date";
  const techParams = isDev ? [companyId] : [companyId, tz, todayStr, endDateStr];

  const { rows } = await db.query(
    `SELECT a.id AS appointment_id, j.id AS job_id, j.scheduled_date,
            j.title AS job_name, j.description AS job_description, j.job_type,
            t.phone AS technician_phone, t.first_name || ' ' || t.last_name AS technician_name,
            c.full_name AS customer_name,
            c.address_line1, c.city, c.state
     FROM appointments a
     JOIN jobs j        ON j.id = a.job_id
     JOIN technicians t ON t.id = a.technician_id
     JOIN customers c   ON c.id = j.customer_id
     WHERE j.company_id = $1
       AND a.status IN ('scheduled','rescheduled')
       AND a.technician_id IS NOT NULL
       AND (a.technician_confirmed IS NULL OR a.technician_confirmed = false)
       AND ${dateFilter}
       AND t.is_active = true`,
    techParams
  );

  logger.info(`Scheduler [technician_unconfirmed]: found ${rows.length} unconfirmed technician appointment(s)`, { companyId, window: `${todayStr} to ${endDateStr}` });

  let c = 0, s = 0;
  for (const row of rows) {
    const jobId = String(row.job_id);
    if (!row.technician_phone) {
      await todosDb.createMissingPhone({
        companyId, jobId, subjectKind: "technician",
        subjectName: row.technician_name, callType: trigger.call_type,
        reason: "Technician phone number not provided — confirmation call could not be placed.",
        metadata: { appointment_id: row.appointment_id || null, customer_name: row.customer_name || null },
        isTest: isDev,
      });
      logger.info("Scheduler [technician_unconfirmed]: todo created — technician missing phone", { companyId, jobId, technician: row.technician_name });
      s++; continue;
    }
    if (await scheduledCallsDb.existsForJob(companyId, jobId, trigger.call_type, isDev)) {
      logger.info("Scheduler [technician_unconfirmed]: skipped — call already exists", {
        companyId, jobId, jobName: row.job_name, technician: row.technician_name,
        reason: "Active or completed scheduled call already exists for this job",
      });
      s++; continue;
    }

    const scheduledAt = isDev
      ? new Date()
      : snapToWindowStart(callSettings, tz, new Date());

    const inserted = await scheduleCall({
      companyId, callType: trigger.call_type,
      phoneNumber: row.technician_phone,
      jobId, jobDate: targetDate,
      appointmentId: row.appointment_id || null,
      technicianName: row.technician_name,
      customerName:   row.customer_name,
      customerAddress: [row.address_line1, row.city, row.state].filter(Boolean).join(", ") || null,
      jobName: row.job_name || null,
      jobDescription: row.job_description || null,
      jobType: row.job_type || null,
      scheduledAt, isTest: isDev, maxAttempts: callSettings.max_attempts,
      callPriority: computeInitialPriority({ triggerType: "technician_unconfirmed", jobDate: targetDate, tz }),
    });
    if (inserted) c++; else {
      logger.info("Scheduler [technician_unconfirmed]: skipped — duplicate on insert", { companyId, jobId });
      s++;
    }
  }
  return { c, s };
}

module.exports = { runDispatcher, runDailyJob, isWithinActiveHours, getNextWindowStart, processUnopenedChatLinks };
