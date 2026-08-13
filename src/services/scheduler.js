const db = require("../db");
const callSettingsDb = require("../db/call-settings");
const callTriggerConfigsDb = require("../db/call-trigger-configs");
const callTypeConfigsDb = require("../db/call-type-configs");
const scheduledCallsDb = require("../db/scheduled-calls");
const todosDb = require("../db/todos");
const { computeInitialPriority } = require("./call-priority");
const { resolveOutboundChannel } = require("./channel-resolver");
const { buildJobConfirmationContext, toDynamicVariables } = require("./job-confirmation-context");
const { resolveConfirmationRecipients } = require("./confirmation-recipients");
const { toLocalDateOnly } = require("../utils/timezone");
const retell = require("./retell");
const chatLinksService = require("./chat-links");
const chatLinksDb = require("../db/chat-links");
const sendEventsDb = require("../db/chat-link-send-events");
const chatLinkEmail = require("./chat-link-email");
const chatLinkSms = require("./chat-link-sms");
const logger = require("../utils/logger");

const isDev = process.env.NODE_ENV === "development";

/**
 * "<service line> — <description>" per service on a visit.
 *
 * Both halves matter and neither substitutes for the other: the line name is
 * the category the customer recognises ("Alarm Systems"), the description is
 * where the detail lives ("Annual Backflow Inspection (1-FL/2-Dom/1-Lawn/
 * 1-Pool/Apollo RP IF4A/Located in Pool Mechanical Room)"). Falls back to
 * whichever half exists rather than emitting a dangling separator.
 *
 * @param {object} appt — a shaped appointment from job-confirmation-context
 * @param {object} [opts]
 * @param {boolean} [opts.inline] — join with "; " for a one-line summary
 *   instead of one service per line.
 */
function formatServiceDetails(appt, { inline = false } = {}) {
  const details = appt?.service_details?.length
    ? appt.service_details
    : (appt?.service_lines || []).map((l) => ({ service_line: l, description: null }));
  const parts = details
    .map(({ service_line, description }) =>
      service_line && description ? `${service_line} — ${description}` : (description || service_line))
    .filter(Boolean);
  return parts.length ? parts.join(inline ? "; " : "\n") : "";
}

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
  // Lapse chat links whose 24h window closed without an outcome. Runs on the
  // frequent tick rather than the daily job on purpose: with a 24h TTL, a link
  // expiring at 10am would otherwise sit reported as live until the next
  // morning's run. One UPDATE against a partial index, so it costs nothing when
  // there is nothing to expire.
  try {
    const expired = await chatLinksDb.expireStale();
    if (expired.length > 0) {
      logger.info("Dispatcher: chat links expired", { expired: expired.length });
      // A conversation can reach an outcome and then be abandoned — the customer
      // confirms, closes the tab, end_conversation never fires. This is the last
      // moment those links are identifiable, so the CRM comment is written now.
      // Each is independent: one failure must not stop the others or the sweep.
      const confirmationAgent = require("../confirmation-agent");
      for (const link of expired) {
        const result = await confirmationAgent
          .postExpiredOutcomeComment({ companyId: link.company_id, jobId: link.job_id, token: link.token })
          .catch((err) => ({ posted: false, reason: "error", error: err.message }));
        if (result.posted) {
          logger.info("Dispatcher: posted CRM comment for an expired chat that had an outcome", {
            companyId: link.company_id, chatLinkId: link.id, outcomes: result.outcomes,
          });
        }
      }
    }
  } catch (err) {
    logger.warn("Dispatcher: chat-link expiry sweep failed", { error: err.message });
  }

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
        // Address the actual recipient by name when this row is for a
        // confirmation contact (a property manager, etc.), not the customer
        // — same substitution the web_chat/sms branches below already make
        // for their own delivery text, just missing here for the live
        // voice-call path until now.
        ...((row.recipient_name || row.customer_name) && { customer_name: row.recipient_name || row.customer_name }),
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

      // ── Job-centric confirmation context ────────────────────────────────
      // Computed HERE, at dispatch, not when the row was queued: a pending row
      // can sit for days, during which appointments get added, moved, cancelled
      // or confirmed elsewhere. Reading it fresh is the only way the agent opens
      // with a count that's actually true.
      //
      // Confirmation calls only, and only for a real numeric job id —
      // scheduled_calls.job_id also carries 'quotation:N' and
      // 'service_opportunity:N-N', which aren't jobs.
      if (row.call_type === "customer_confirmation" && /^\d+$/.test(String(row.job_id || ""))) {
        const jobCtx = await buildJobConfirmationContext(row.company_id, row.job_id, { tz: callTz });
        if (jobCtx.ok) {
          Object.assign(dynVars, toDynamicVariables(jobCtx));

          // ── Appointment facts, pre-bound for the OPENING ──────────────
          // Retell binds dynamic variables once at call creation, so these
          // are a snapshot — the same staleness tradeoff job_comments
          // already accepts. That's fine for opening the call, and it's what
          // removes get_appointments from the critical path: the agent can
          // name the real service/date/count in its first breath instead of
          // stalling on a tool round-trip while the customer waits.
          //
          // Anything that CHANGES mid-call (after a confirm/reschedule/
          // cancel) must still come from get_appointments — the prompt says
          // so explicitly. These are for the opening, not a replacement for
          // live state.
          //
          // Computed from the jobCtx this dispatcher already builds above —
          // no extra query, no added dispatch latency.
          const next = jobCtx.appointments.next;
          const upcoming = jobCtx.appointments.upcoming;
          dynVars.upcoming_count = String(jobCtx.counts.upcoming);
          dynVars.unconfirmed_count = String(jobCtx.counts.unconfirmed);
          dynVars.all_upcoming_confirmed = jobCtx.counts.all_confirmed ? "true" : "false";
          if (next) {
            // Every service on the visit, not just the first: an appointment
            // bundling backflow + alarm + extinguisher + sprinkler used to be
            // announced as "Backflow" alone. service_summary is the spoken
            // form ("Backflow, Alarm Systems and Sprinkler").
            dynVars.next_service_line =
              next.service_summary || next.service_line || jobCtx.job.title || "your upcoming visit";
            dynVars.next_appointment_date = next.scheduled_start_spoken;
            // A crew does not land on the minute, and "8:00 AM" is heard as
            // exact. Precomputed in the context — never ask the agent to do
            // clock arithmetic.
            dynVars.next_arrival_window = next.arrival_window_spoken || "";
            dynVars.next_appointment_id = String(next.appointment_id);
            // The whole crew, not just appointments.technician_id — most
            // multi-service visits send two to four technicians.
            dynVars.next_technician = next.technician_summary || next.technician || "";

            // The rich pair, one service per line: category AND the free-text
            // description, which is where the real detail lives ("Annual
            // Backflow Inspection (1-FL/2-Dom/1-Lawn/1-Pool/Apollo RP IF4A/
            // Located in Pool Mechanical Room)"). next_service_line is only
            // the short spoken categories for the opening sentence; this is
            // what the agent reads when the customer asks what's actually
            // being done, and what lets it match the right onsite-expectation
            // entry.
            dynVars.next_appointment_services = formatServiceDetails(next);

            // Full crew with contact details, one per line, so the agent can
            // answer "who's coming?" and "can I reach them?" without a tool
            // call. next_technician stays the short spoken list.
            dynVars.next_technicians = (next.technicians || [])
              .filter((t) => t.name)
              .map((t) => {
                const contact = [t.phone, t.email].filter(Boolean).join(", ");
                return contact ? `${t.name} (${contact})` : t.name;
              })
              .join("\n");
          }
          // One flat line per upcoming appointment — dynamic variables are
          // strings, so the list is pre-rendered here rather than asking the
          // model to format a JSON blob mid-call. Capped: this rides in
          // every turn's context, and a recurring-service job can have 30+.
          if (upcoming.length) {
            const MAX_INLINE = 8;
            const lines = upcoming.slice(0, MAX_INLINE).map((a) => {
              const bits = [`#${a.appointment_id}`, a.scheduled_start_spoken];
              // Full per-service wording here (not the short spoken summary):
              // this is reference context the agent reads, and it's what lets
              // it match the right onsite-expectation entry.
              const svc = formatServiceDetails(a, { inline: true });
              if (svc) bits.push(`for ${svc}`);
              else if (a.service_line) bits.push(`for ${a.service_line}`);
              const techs = a.technician_names?.length ? a.technician_names : (a.technician ? [a.technician] : []);
              if (techs.length) bits.push(`with ${techs.join(", ")}`);
              bits.push(a.customer_confirmed ? "(confirmed)" : "(not yet confirmed)");
              return bits.join(" ");
            });
            if (upcoming.length > MAX_INLINE) {
              lines.push(`...plus ${upcoming.length - MAX_INLINE} more — call get_appointments to see the rest.`);
            }
            dynVars.upcoming_appointments = lines.join("\n");
          }
        } else {
          logger.warn("Dispatcher: job confirmation context unavailable, falling back to flat row vars", {
            scheduledCallId: row.id, jobId: row.job_id, code: jobCtx.code,
          });
        }

        // Known email/phone — same recipient-vs-customer resolution the
        // web_chat branch below already does — so the agent can present it
        // for confirmation in the SERVICE LINK step instead of asking blind.
        if (row.recipient_contact_id != null) {
          if (row.recipient_email) dynVars.customer_email = row.recipient_email;
          if (row.phone_number) dynVars.customer_phone = row.phone_number;
        } else {
          const { rows: custContactRows } = await db.query(
            `SELECT c.email, c.phone FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = $1 AND j.company_id = $2`,
            [row.job_id, row.company_id]
          );
          if (custContactRows[0]?.email) dynVars.customer_email = custContactRows[0].email;
          if (custContactRows[0]?.phone) dynVars.customer_phone = custContactRows[0].phone;
        }
      }

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
        // One shared chat_links token, delivered by email and/or SMS.
        // row.link_delivery is the per-customer resolution made at queue time
        // (migration 080 — customers.is_sms/is_email); the company-level
        // chat_link_delivery_method is only a fallback for rows queued before
        // a customer's flags were resolvable (e.g. no customers join for that
        // trigger). Same underlying mechanism the plain "sms" channel below
        // uses too — retell_call_id stays null until the customer actually
        // opens the link, regardless of medium.
        const deliveryMethod = row.link_delivery
          || (await callSettingsDb.getByCompanyId(row.company_id)).chat_link_delivery_method;

        // A manually-supplied email/phone (e.g. the "Email Now" button, when
        // the customer record itself has none — the common case for
        // ServiceTrade-synced customers, whose email lives on a separate
        // Contact, not synced here) travels through call_context since this
        // dispatch step re-reads the row from the DB and has no other way to
        // see it.
        const overrideEmail = row.call_context?.override_email || null;
        const overridePhone = row.call_context?.override_phone || null;

        // recipient_contact_id NULL = the customer themselves — re-query
        // fresh (ServiceTrade sync can update the customer's own contact
        // info between queue and dispatch). A non-null recipient uses the
        // snapshot taken at enqueue time (recipient_name/recipient_email,
        // phone_number) instead — a contacts row's phone/email is low-churn,
        // so re-fetching fresh buys nothing a snapshot doesn't already cover.
        let customerEmail, customerPhone;
        if (row.recipient_contact_id != null) {
          customerEmail = overrideEmail || row.recipient_email || null;
          customerPhone = overridePhone || row.phone_number || null;
        } else {
          const { rows: custRows } = await db.query(
            `SELECT c.email, c.phone FROM jobs j JOIN customers c ON c.id = j.customer_id WHERE j.id = $1 AND j.company_id = $2`,
            [row.job_id, row.company_id]
          );
          customerEmail = overrideEmail || custRows[0]?.email || null;
          customerPhone = overridePhone || custRows[0]?.phone || null;
        }

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
          ? await chatLinksService.createChatLinkForAppointment(row.company_id, row.appointment_id, row.call_type, row.recipient_contact_id)
          : await chatLinksService.createChatLinkForJob(row.company_id, row.job_id, row.call_type, row.recipient_contact_id);
        if (!linkResult.ok) throw new Error(linkResult.error || "Failed to create chat link");

        // Each leg is caught independently — for 'both', one leg throwing
        // must NOT cause the whole row to retry, since a retry would
        // re-send whichever leg already succeeded (e.g. re-emailing the
        // customer while only the sms leg actually needs another attempt).
        let emailSent = false, smsSent = false, emailError = null, smsError = null;
        // Address the actual recipient by name when this row is for a
        // confirmation contact (a property manager, etc.), not the customer.
        const greetingName = row.recipient_name || row.customer_name;

        // Tell the CONVERSATION who it is talking to, not just the email/SMS.
        // Deliberately narrower than greetingName: only a contacts row is a
        // person. row.customer_name is an account ("JACK LTR", "123 California
        // Ave") and the agent must not greet it as a human — so the name goes in
        // only when this row is for a real contact.
        await chatLinksDb.setRecipient(linkResult.token, {
          name: row.recipient_contact_id != null ? row.recipient_name || null : null,
          email: customerEmail,
          phone: customerPhone,
        }).catch((err) =>
          logger.warn("Dispatcher: failed to snapshot chat link recipient", { ...ctx, error: err.message }));

        if (wantEmail && customerEmail) {
          try {
            await chatLinkEmail.sendConfirmationLinkEmail({
              email: customerEmail,
              customerName: greetingName,
              companyName: co.company_name || "our company",
              jobName: row.job_name,
              token: linkResult.token,
            });
            emailSent = true;
          } catch (err) {
            emailError = err;
          }
          // Logged whether it went or not: a failed leg is exactly the evidence
          // wanted when a customer says nothing arrived.
          await sendEventsDb.recordSafe({
            companyId: row.company_id, token: linkResult.token, medium: "email",
            destination: customerEmail, origin: "scheduler", scheduledCallId: row.id,
            ok: emailSent, error: emailError?.message ?? null,
          });
        } else if (wantEmail) {
          logger.warn("Dispatcher: chat_link_delivery_method wants email but customer has none — sending sms only", { ...ctx });
        }

        if (wantSms && customerPhone) {
          try {
            await chatLinkSms.sendConfirmationLinkSms({
              phone: customerPhone,
              customerName: greetingName,
              companyName: co.company_name || "our company",
              jobName: row.job_name,
              token: linkResult.token,
            });
            smsSent = true;
          } catch (err) {
            smsError = err;
          }
          await sendEventsDb.recordSafe({
            companyId: row.company_id, token: linkResult.token, medium: "sms",
            destination: customerPhone, origin: "scheduler", scheduledCallId: row.id,
            ok: smsSent, error: smsError?.message ?? null,
          });
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
        // sent_at is stamped HERE, not at link creation, so "sent" means a leg
        // actually went out rather than "a token exists". A staff member
        // copying a link by hand therefore leaves sent_at null.
        await chatLinksDb.markSent(linkResult.token).catch((err) =>
          logger.warn("Dispatcher: failed to stamp chat link sent_at", { ...ctx, error: err.message }));
        // Stamped explicitly rather than left to the column default: a link a
        // staff member copied by hand earlier would otherwise still read
        // 'manual' after the scheduler sent it.
        await chatLinksDb.setOrigin(linkResult.token, { origin: "scheduler", userId: null }).catch(() => {});
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
          ? await chatLinksService.createChatLinkForAppointment(row.company_id, row.appointment_id, row.call_type, row.recipient_contact_id)
          : await chatLinksService.createChatLinkForJob(row.company_id, row.job_id, row.call_type, row.recipient_contact_id);
        if (!linkResult.ok) throw new Error(linkResult.error || "Failed to create chat link");

        await chatLinkSms.sendConfirmationLinkSms({
          phone: row.phone_number,
          customerName: row.recipient_name || row.customer_name,
          companyName: co.company_name || "our company",
          jobName: row.job_name,
          token: linkResult.token,
        });

        // Same snapshot as the web_chat branch — a person's name only.
        await chatLinksDb.setRecipient(linkResult.token, {
          name: row.recipient_contact_id != null ? row.recipient_name || null : null,
          email: row.recipient_email || null,
          phone: row.phone_number || null,
        }).catch((err) =>
          logger.warn("Dispatcher: failed to snapshot chat link recipient", { ...ctx, error: err.message }));

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

async function tryScheduleCall(params) {
  try {
    const row = await scheduledCallsDb.create(params);
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
    return row;
  } catch (err) {
    if (err.code === "DUPLICATE_SCHEDULED_CALL" || err.code === "23505") return null;
    throw err;
  }
}

// Back-compat boolean wrapper — most call sites only care whether the row
// was actually inserted (vs. deduped away), not the row itself.
async function scheduleCall(params) {
  return !!(await tryScheduleCall(params));
}

/**
 * Everything it takes to turn one "here's a job + its customer" row into
 * queued scheduled_calls rows (or skips-with-reason): resolve the channel
 * ONCE per customer, then fan out to every resolved recipient (the customer
 * themselves and/or their opted-in confirmation_contact_ids — migration 081)
 * — one row per recipient, each gated/deduped/inserted independently, so one
 * recipient missing a phone never blocks another. Shared by the nightly
 * sweep (processScheduledUnconfirmed) and the manual
 * POST /jobs/bulk-send-confirmation route — the two must never diverge on
 * this logic, or a job that's fine for one path silently isn't for the other.
 *
 * @param {object} row  — must carry: job_id, job_name, job_description, job_type,
 *   appointment_id (lead), lead_scheduled_start, scheduled_date (job fallback date),
 *   customer_id, customer_phone, customer_email, customer_name, address_line1, city, state,
 *   is_voice, is_sms, is_email, confirmation_include_customer, confirmation_contact_ids
 * @param {object} [opts]
 * @param {boolean} [opts.devOverride]     — defaults to the module's isDev
 * @param {string}  [opts.callPriority]    — defaults to computeInitialPriority's result
 * @param {boolean} [opts.bypassOfficeHours=false] — true fires scheduledAt = now
 * @returns {Promise<Array<object>>} one result per resolved recipient
 */
async function enqueueConfirmationForJobRow(companyId, callType, callSettings, tz, smsLive, row, opts = {}) {
  const { devOverride = null, callPriority = null, bypassOfficeHours = false } = opts;
  const dev = devOverride ?? isDev;
  const jobId = String(row.job_id);

  // Channel is a single per-customer decision — resolved once, before the
  // contact-completeness gate below (resolveOutboundChannel only depends on
  // the customer's flags/settings, never on any one recipient's contact
  // info, so this ordering is always safe) and applies to every recipient.
  const { channel, linkDelivery } = resolveOutboundChannel({
    smsLive,
    flags: { is_voice: row.is_voice, is_sms: row.is_sms, is_email: row.is_email },
    channelStrategy: callSettings.channel_strategy,
  });

  const recipients = await resolveConfirmationRecipients(
    companyId,
    {
      // `id` is what lets the resolver reach this customer's contacts for the
      // company-wide contact-type default (migration 087). Without it that
      // rule is skipped and resolution falls back to the customer record.
      id: row.customer_id,
      full_name: row.customer_name,
      phone: row.customer_phone,
      email: row.customer_email,
      confirmation_include_customer: row.confirmation_include_customer,
      confirmation_contact_ids: row.confirmation_contact_ids,
    },
    { contactTypes: callSettings.confirmation_contact_types || [] }
  );

  const scheduledAt = bypassOfficeHours || dev
    ? new Date()
    : snapToWindowStart(callSettings, tz, new Date());

  // The LEAD APPOINTMENT's own day, not the trigger window's end — job_date
  // isn't cosmetic: scheduleRetry/scheduleCallback gate on
  // `nextWindowAt >= jobDueDate`, and computeInitialPriority uses it for
  // urgency. Falls back to the job's own scheduled_date when there's no lead
  // (shouldn't happen for a job with an eligible appointment, but a job-level
  // date beats nothing).
  const leadJobDate = toLocalDateOnly(row.lead_scheduled_start, tz)
    || (row.scheduled_date ? toLocalDateOnly(row.scheduled_date, tz) : null);

  const results = [];
  for (const recipient of recipients) {
    results.push(await enqueueConfirmationForRecipient({
      companyId, callType, callSettings, tz, dev, jobId, row, recipient,
      channel, linkDelivery, scheduledAt, leadJobDate, callPriority, bypassOfficeHours,
    }));
  }
  return results;
}

/**
 * One recipient's worth of enqueueConfirmationForJobRow — the
 * missing_phone/missing_email gate and the dedupe check are evaluated
 * per-recipient (a recipient missing what the resolved channel needs is
 * skipped/todo'd on their own; other recipients still queue).
 */
async function enqueueConfirmationForRecipient({
  companyId, callType, callSettings, tz, dev, jobId, row, recipient,
  channel, linkDelivery, scheduledAt, leadJobDate, callPriority, bypassOfficeHours,
}) {
  const { recipientContactId, name: recipientName, phone: recipientPhone, email: recipientEmail } = recipient;
  const subjectName = recipientName || row.customer_name;

  if (channel !== "web_chat" && !recipientPhone) {
    await todosDb.createMissingPhone({
      companyId, jobId, subjectKind: "customer",
      subjectName, callType,
      reason: "Phone number not provided — confirmation call could not be placed.",
      isTest: dev,
    });
    return { status: "skipped", reason: "missing_phone", channel, linkDelivery, recipientContactId };
  }

  // Contact-completeness gate for web_chat — required contact info depends on
  // the customer's is_sms/is_email flags, resolved above into linkDelivery
  // ('email' needs an email on file; 'sms' needs a phone; 'both' needs at
  // least one) — evaluated against THIS recipient's own phone/email.
  if (channel === "web_chat") {
    const needsEmail = linkDelivery === "email" && !recipientEmail;
    const needsPhone = linkDelivery === "sms" && !recipientPhone;
    const needsEither = linkDelivery === "both" && !recipientEmail && !recipientPhone;

    if (needsEmail || needsEither) {
      await todosDb.createMissingEmail({
        companyId, jobId, subjectKind: "customer",
        subjectName, callType,
        reason: "Email not provided — confirmation chat link could not be sent.",
        isTest: dev,
      });
      return { status: "skipped", reason: "missing_email", channel, linkDelivery, recipientContactId };
    }
    if (needsPhone) {
      await todosDb.createMissingPhone({
        companyId, jobId, subjectKind: "customer",
        subjectName, callType,
        reason: "Phone number not provided — confirmation chat could not be texted.",
        isTest: dev,
      });
      return { status: "skipped", reason: "missing_phone", channel, linkDelivery, recipientContactId };
    }
  }

  if (await scheduledCallsDb.existsForCustomerJob(companyId, jobId, callType, dev, recipientContactId)) {
    return { status: "skipped", reason: "already_queued", channel, linkDelivery, recipientContactId };
  }

  const insertedRow = await tryScheduleCall({
    companyId, callType,
    phoneNumber: recipientPhone,
    jobId, jobDate: leadJobDate,
    appointmentId: row.appointment_id || null,
    customerName: row.customer_name,
    customerAddress: [row.address_line1, row.city, row.state].filter(Boolean).join(", ") || null,
    jobName: row.job_name || null,
    jobDescription: row.job_description || null,
    jobType: row.job_type || null,
    scheduledAt, isTest: dev, maxAttempts: callSettings.max_attempts,
    callPriority: callPriority || computeInitialPriority({ triggerType: "scheduled_unconfirmed", jobDate: leadJobDate, tz }),
    bypassOfficeHours,
    channel, linkDelivery,
    recipientContactId, recipientName, recipientEmail,
  });

  if (!insertedRow) return { status: "skipped", reason: "already_queued", channel, linkDelivery, recipientContactId };

  return {
    status: "queued", channel, linkDelivery, recipientContactId,
    scheduled_call_id: insertedRow.id,
    scheduled_at: insertedRow.scheduled_at,
  };
}

/**
 * Single-job entry point for the manual "Send Confirmation" flow
 * (POST /jobs/bulk-send-confirmation calls this once per selected job).
 * Unlike the nightly sweep, there's no eligibility/date-window gate — the
 * tenant explicitly chose this job — but a job with no upcoming appointment
 * still has nothing to confirm, so that's still a skip, not a queue.
 */
async function enqueueJobConfirmation(companyId, jobId, { callType = "customer_confirmation", callSettings, tz, smsLive = false, callPriority = null, bypassOfficeHours = false } = {}) {
  const { rows } = await db.query(
    `SELECT j.id AS job_id, j.scheduled_date, j.status AS job_status,
            j.title AS job_name, j.description AS job_description, j.job_type,
            lead.id AS appointment_id, lead.status AS appointment_status,
            lead.scheduled_start AS lead_scheduled_start,
            c.id AS customer_id,
            c.phone AS customer_phone, c.email AS customer_email, c.full_name AS customer_name,
            c.address_line1, c.city, c.state, c.is_voice, c.is_sms, c.is_email,
            c.confirmation_include_customer, c.confirmation_contact_ids
       FROM jobs j
       JOIN customers c ON c.id = j.customer_id
       LEFT JOIN LATERAL (
         SELECT a.id, a.status, a.scheduled_start
           FROM appointments a
          WHERE a.company_id = j.company_id AND a.job_id = j.id
            AND a.status IN ('scheduled','confirmed','rescheduled')
            AND a.scheduled_start > NOW()
          ORDER BY a.scheduled_start ASC
          LIMIT 1
       ) lead ON true
      WHERE j.company_id = $1 AND j.id = $2`,
    [companyId, jobId]
  );
  const row = rows[0];
  // Returns an array (one entry per resolved recipient) for consistency with
  // enqueueConfirmationForJobRow — these two early-exit cases wrap a single
  // failure/skip in a one-element array rather than returning a bare object.
  if (!row) return [{ status: "failed", reason: "job_not_found" }];
  if (!row.appointment_id) return [{ status: "skipped", reason: "no_upcoming_appointment" }];

  const cs = callSettings || await callSettingsDb.getByCompanyId(companyId);
  const tzResolved = tz || (await (async () => {
    const { rows: co } = await db.query(`SELECT default_timezone FROM companies WHERE id = $1`, [companyId]);
    return co[0]?.default_timezone || "America/New_York";
  })());

  return enqueueConfirmationForJobRow(companyId, callType, cs, tzResolved, smsLive, row, { callPriority, bypassOfficeHours });
}

// A web_chat/sms confirmation whose link has sat unopened this long is
// treated as the "no answer" equivalent — there's no chat_ended/chat_analyzed
// webhook to react to if the customer never opened it at all, so this can't
// reuse the existing webhook-driven retry path. Matches the chat-link TTL
// (createChatLinkForJob/Appointment) so the watchdog fires right as the link
// dies rather than 24h after it's already unusable.
const CHAT_LINK_UNOPENED_WINDOW_HOURS = 24;

async function processUnopenedChatLinks(companyId) {
  const { rows: coRows } = await db.query(`SELECT sms_status FROM companies WHERE id = $1`, [companyId]);
  const smsLive = coRows[0]?.sms_status === "live";

  const { rows } = await db.query(
    `SELECT sc.id, sc.job_id, sc.appointment_id, sc.call_type, sc.customer_name,
            sc.job_name, sc.job_description, sc.job_type, sc.job_date,
            sc.is_test, sc.max_attempts, sc.retry_count, sc.phone_number,
            c.is_voice, c.is_sms, c.is_email
     FROM scheduled_calls sc
     JOIN chat_links cl ON cl.token = sc.chat_link_token
     LEFT JOIN jobs j      ON j.id::text = sc.job_id AND j.company_id = sc.company_id
     LEFT JOIN customers c ON c.id = j.customer_id
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
    // Cap re-sends — a customer who never engages on any channel shouldn't be
    // messaged forever. parent_call_id chains carry retry_count forward
    // (fallbackToLink resets it, this path doesn't — a stale link warrants
    // the same cap as a stale voice attempt).
    if ((row.retry_count || 0) >= row.max_attempts) {
      logger.info("Scheduler [unopened_chat_link]: capped — max_attempts reached, not re-sending", { companyId, jobId, retryCount: row.retry_count, maxAttempts: row.max_attempts });
      continue;
    }

    // Re-resolve from the customer's own flags rather than hardcoding voice:
    // an is_voice customer gets a real call; a link-only customer gets a
    // fresh link (the old one is dead — expired tokens 404). No customer row
    // resolvable (shouldn't happen for a job-scoped confirmation) defaults to
    // voice, same as the old unconditional behavior.
    const flags = row.is_voice != null ? { is_voice: row.is_voice, is_sms: row.is_sms, is_email: row.is_email } : null;
    const wantVoice = flags ? flags.is_voice : true;
    const channel = wantVoice ? "voice" : "web_chat";
    const linkDelivery = wantVoice
      ? null
      : (flags.is_sms && smsLive && flags.is_email) ? "both"
      : (flags.is_sms && smsLive) ? "sms"
      : "email"; // is_email, or the last-resort default when neither survived the smsLive check

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
      retryCount: (row.retry_count || 0) + 1,
      channel, linkDelivery,
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

  const dateFilter = isDev
    ? "a.scheduled_start >= NOW()"
    : "DATE(a.scheduled_start AT TIME ZONE $2) BETWEEN $3::date AND $4::date";
  const params = isDev ? [companyId] : [companyId, tz, todayStr, endDateStr];

  // One call per JOB, covering every upcoming appointment on it.
  //
  // Eligibility and lead selection are deliberately separate concerns:
  //   • ELIGIBLE (the EXISTS clause) — does this job have at least one
  //     unconfirmed upcoming appointment inside the trigger's date window? That
  //     decides *whether* we reach out.
  //   • LEAD (the first LATERAL) — the earliest upcoming appointment, period,
  //     confirmed or not. That decides *which one the agent talks about first*.
  //
  // The previous DISTINCT ON form conflated the two: it joined only unconfirmed
  // appointments, so on a job whose first visit was already confirmed it named
  // the SECOND visit as the subject of the call, and it could never see
  // status='confirmed' appointments at all when counting. 'confirmed' counts as
  // upcoming here for exactly that reason.
  const { rows } = await db.query(
    `SELECT j.id AS job_id, j.job_number, j.scheduled_date, j.status AS job_status,
            j.title AS job_name, j.description AS job_description, j.job_type,
            lead.id AS appointment_id, lead.status AS appointment_status,
            lead.scheduled_start AS lead_scheduled_start,
            cnt.upcoming_count, cnt.unconfirmed_count,
            c.id AS customer_id,
            c.phone AS customer_phone, c.email AS customer_email, c.full_name AS customer_name,
            c.address_line1, c.city, c.state, c.is_voice, c.is_sms, c.is_email,
            c.confirmation_include_customer, c.confirmation_contact_ids
     FROM jobs j
     JOIN customers c ON c.id = j.customer_id
     JOIN LATERAL (
       SELECT a.id, a.status, a.scheduled_start
         FROM appointments a
        WHERE a.company_id = j.company_id AND a.job_id = j.id
          AND a.status IN ('scheduled','confirmed','rescheduled')
          AND a.scheduled_start > NOW()
        ORDER BY a.scheduled_start ASC
        LIMIT 1
     ) lead ON true
     JOIN LATERAL (
       SELECT count(*) AS upcoming_count,
              count(*) FILTER (WHERE COALESCE(a.customer_confirmed, false) = false) AS unconfirmed_count
         FROM appointments a
        WHERE a.company_id = j.company_id AND a.job_id = j.id
          AND a.status IN ('scheduled','confirmed','rescheduled')
          AND a.scheduled_start > NOW()
     ) cnt ON true
     WHERE j.company_id = $1
       AND j.status IN ('scheduled','rescheduled')
       AND cnt.unconfirmed_count > 0
       AND EXISTS (
         SELECT 1 FROM appointments a
          WHERE a.company_id = j.company_id AND a.job_id = j.id
            AND a.status IN ('scheduled','confirmed','rescheduled')
            AND COALESCE(a.customer_confirmed, false) = false
            AND a.scheduled_start > NOW()
            AND ${dateFilter}
       )
     ORDER BY lead.scheduled_start ASC`,
    params
  );

  logger.info(`Scheduler [scheduled_unconfirmed]: found ${rows.length} unconfirmed appointment(s)`, { companyId, window: `${todayStr} to ${endDateStr}` });

  let c = 0, s = 0;
  for (const row of rows) {
    const jobId = String(row.job_id);
    // One result per resolved recipient (the customer and/or their opted-in
    // confirmation_contact_ids) — fold across all of them for this job's count.
    const results = await enqueueConfirmationForJobRow(companyId, trigger.call_type, callSettings, tz, smsLive, row);
    for (const result of results) {
      if (result.status === "queued") {
        c++;
      } else {
        logger.info(`Scheduler [scheduled_unconfirmed]: skipped — ${result.reason}`, {
          companyId, jobId, jobName: row.job_name, customer: row.customer_name, channel: result.channel,
          recipientContactId: result.recipientContactId,
        });
        s++;
      }
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
            c.phone AS customer_phone, c.full_name AS customer_name,
            c.is_voice, c.is_sms, c.is_email
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

    const { channel, linkDelivery } = resolveOutboundChannel({
      smsLive,
      flags: { is_voice: row.is_voice, is_sms: row.is_sms, is_email: row.is_email },
      channelStrategy: callSettings.channel_strategy,
    });

    const inserted = await scheduleCall({
      companyId, callType: trigger.call_type,
      phoneNumber: row.customer_phone,
      jobId, jobDate: null,
      customerName: row.customer_name,
      jobName: row.quote_title || null,
      jobDescription: row.quote_description || null,
      totalAmount: row.total_amount ?? null,
      linkDelivery,
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
           c.address_line1, c.city, c.state, c.is_voice, c.is_sms, c.is_email
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

    const { channel, linkDelivery } = resolveOutboundChannel({
      smsLive,
      flags: { is_voice: row.is_voice, is_sms: row.is_sms, is_email: row.is_email },
      channelStrategy: callSettings.channel_strategy,
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
      channel, linkDelivery,
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

module.exports = { runDispatcher, runDailyJob, isWithinActiveHours, getNextWindowStart, processUnopenedChatLinks, enqueueJobConfirmation };
