const db = require("../db");
const callSettingsDb = require("../db/call-settings");
const campaignsDb = require("../db/campaigns");
const scheduledCallsDb = require("../db/scheduled-calls");
const todosDb = require("../db/todos");
const { computeInitialPriority } = require("./call-priority");
const retell = require("./retell");
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
      };

      // Resolve campaign-specific voicemail message with actual values.
      // row.call_type now holds the campaign key.
      const campaignCfg = await campaignsDb.getByKey(row.company_id, row.call_type);
      const vmTemplate = campaignCfg?.voicemail_message
        || campaignsDb.generateDefaultVoicemailMessage(campaignsDb.PROMPT_BASIS[row.call_type] || row.call_type);
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
        .replace(/\{\{company_name\}\}/g,        co.company_name || "our company");

      const call = await retell.createCall({
        toNumber: row.phone_number,
        companyId: row.company_id,
        callType: row.call_type,
        dynamicVariables: dynVars,
        metadata: { scheduled_call_id: String(row.id), is_test: row.is_test },
        voicemailMessage,
      });
      await scheduledCallsDb.markCompleted(row.id, call.call_id);
      logger.info("Dispatcher: fired", { ...ctx, retellCallId: call.call_id });
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
      ? `SELECT id, default_timezone FROM companies WHERE id = $1 AND (is_active = true OR is_active IS NULL)`
      : `SELECT id, default_timezone FROM companies WHERE is_active = true OR is_active IS NULL`,
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

      const triggers = await campaignsDb.getEnabledByCompanyId(co.id);
      if (triggers.length === 0) {
        logger.info("Daily job: skipped company — no enabled triggers", { companyId: co.id });
        continue;
      }
      const tz = co.default_timezone || "America/New_York";
      logger.info(`Daily job: company has ${triggers.length} enabled trigger(s)`, {
        companyId: co.id, tz, triggers: triggers.map(t => t.trigger_type),
      });

      for (const trigger of triggers) {
        try {
          if (engine) await engine.transition("running_trigger", { trigger_type: trigger.trigger_type, company_id: co.id });
          const { c, s } = await processTrigger(co.id, trigger, cs, tz);
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

async function processTrigger(companyId, trigger, callSettings, tz) {
  switch (trigger.trigger_type) {
    case "scheduled_unconfirmed":  return processScheduledUnconfirmed(companyId, trigger, callSettings, tz);
    case "quotation_pending":      return processQuotationPending(companyId, trigger, callSettings, tz);
    case "open_job_due_soon":      return processOpenJobDueSoon(companyId, trigger, callSettings, tz);
    case "technician_unconfirmed": return processTechnicianUnconfirmed(companyId, trigger, callSettings, tz);
    case "post_job_review":        return processPostJobReview(companyId, trigger, callSettings, tz);
    default: return { c: 0, s: 0 };
  }
}

/**
 * Dev:  schedule NOW+5min, is_test=true, match any upcoming unconfirmed appointment
 * Prod: schedule at business-hours window N days from now, is_test=false
 */
async function processScheduledUnconfirmed(companyId, trigger, callSettings, tz) {
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
            j.id AS job_id, j.status AS job_status,
            j.title AS job_name, j.description AS job_description, j.job_type,
            a.status AS appointment_status,
            c.phone AS customer_phone, c.full_name AS customer_name,
            c.address_line1, c.city, c.state
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
    if (!row.customer_phone) {
      await todosDb.createMissingPhone({
        companyId, jobId, subjectKind: "customer",
        subjectName: row.customer_name, callType: trigger.trigger_type,
        reason: "Customer phone number not provided — confirmation call could not be placed.",
        isTest: isDev,
      });
      logger.info("Scheduler [scheduled_unconfirmed]: todo created — customer missing phone", { companyId, jobId, customer: row.customer_name });
      s++; continue;
    }
    if (await scheduledCallsDb.existsForCustomerJob(companyId, jobId, trigger.trigger_type, isDev)) {
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
      companyId, callType: trigger.trigger_type,
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
    });
    if (inserted) c++; else {
      logger.info("Scheduler [scheduled_unconfirmed]: skipped — duplicate on insert", { companyId, jobId });
      s++;
    }
  }
  return { c, s };
}

async function processQuotationPending(companyId, trigger, callSettings, tz) {
  const cfg = trigger.trigger_config;
  const quoteStatuses = cfg.quote_statuses ?? ["sent", "viewed"];
  const daysAfterSent = cfg.days_after_sent ?? 3;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysAfterSent);

  const { rows } = await db.query(
    `SELECT q.id AS quotation_id, q.job_id, q.title AS quote_title, q.notes AS quote_description,
            q.total_amount, q.currency,
            c.phone AS customer_phone, c.full_name AS customer_name
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
        subjectName: row.customer_name, callType: trigger.trigger_type,
        reason: "Customer phone number not provided — quotation follow-up call could not be placed.",
        metadata: { quotation_id: row.quotation_id },
        isTest: isDev,
      });
      logger.info("Scheduler [quotation_pending]: todo created — customer missing phone", { companyId, quotationId: row.quotation_id, customer: row.customer_name });
      s++; continue;
    }
    if (await scheduledCallsDb.existsForQuotation(companyId, row.quotation_id, row.job_id, trigger.trigger_type, isDev)) {
      logger.info("Scheduler [quotation_pending]: skipped — call already exists", {
        companyId, quotationId: row.quotation_id, jobName: row.quote_title, customer: row.customer_name,
        reason: "Active or completed scheduled call already exists for this quotation",
      });
      s++; continue;
    }

    const scheduledAt = isDev
      ? new Date()
      : getNextWindowStart(callSettings, tz);

    const inserted = await scheduleCall({
      companyId, callType: trigger.trigger_type,
      phoneNumber: row.customer_phone,
      jobId, jobDate: null,
      customerName: row.customer_name,
      jobName: row.quote_title || null,
      jobDescription: row.quote_description || null,
      totalAmount: row.total_amount ?? null,
      scheduledAt, isTest: isDev, maxAttempts: callSettings.max_attempts,
      callPriority: computeInitialPriority({ triggerType: "quotation_pending", jobDate: null, tz }),
    });
    if (inserted) c++; else {
      logger.info("Scheduler [quotation_pending]: skipped — duplicate on insert", { companyId, quotationId: row.quotation_id });
      s++;
    }
  }
  return { c, s };
}

async function processOpenJobDueSoon(companyId, trigger, callSettings, tz) {
  const todayStr = formatDateInTz(new Date(), tz);
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + trigger.days_before);
  const endDateStr = formatDateInTz(endDate, tz);
  const cfg = trigger.trigger_config;
  const targetDate = new Date(endDateStr);

  // Window: today through today + days_before (inclusive)
  const dateClause = isDev
    ? "j.due_by >= CURRENT_DATE"
    : "j.due_by BETWEEN $2::date AND $3::date";

  let query = `
    SELECT j.id AS job_id, j.due_by,
           j.title AS job_name, j.description AS job_description, j.job_type,
           c.phone AS customer_phone, c.full_name AS customer_name,
           c.address_line1, c.city, c.state
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
        subjectName: row.customer_name, callType: trigger.trigger_type,
        reason: "Customer phone number not provided — due-soon job confirmation could not be placed.",
        isTest: isDev,
      });
      logger.info("Scheduler [open_job_due_soon]: todo created — customer missing phone", { companyId, jobId, customer: row.customer_name });
      s++; continue;
    }
    if (await scheduledCallsDb.existsForCustomerJob(companyId, jobId, trigger.trigger_type, isDev)) {
      logger.info("Scheduler [open_job_due_soon]: skipped — call already exists", {
        companyId, jobId, jobName: row.job_name, customer: row.customer_name,
        reason: "Active or completed scheduled call already exists for this job",
      });
      s++; continue;
    }

    const scheduledAt = isDev
      ? new Date()
      : snapToWindowStart(callSettings, tz, new Date());

    const inserted = await scheduleCall({
      companyId, callType: trigger.trigger_type,
      phoneNumber: row.customer_phone,
      jobId, jobDate: targetDate,
      customerName: row.customer_name,
      customerAddress: [row.address_line1, row.city, row.state].filter(Boolean).join(", ") || null,
      jobName: row.job_name || null,
      jobDescription: row.job_description || null,
      jobType: row.job_type || null,
      scheduledAt, isTest: isDev, maxAttempts: callSettings.max_attempts,
      callPriority: computeInitialPriority({ triggerType: "open_job_due_soon", jobDate: targetDate, tz }),
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
    `SELECT a.id AS appointment_id, j.id AS job_id,
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
        subjectName: row.technician_name, callType: trigger.trigger_type,
        reason: "Technician phone number not provided — confirmation call could not be placed.",
        metadata: { appointment_id: row.appointment_id || null, customer_name: row.customer_name || null },
        isTest: isDev,
      });
      logger.info("Scheduler [technician_unconfirmed]: todo created — technician missing phone", { companyId, jobId, technician: row.technician_name });
      s++; continue;
    }
    if (await scheduledCallsDb.existsForJob(companyId, jobId, trigger.trigger_type, isDev)) {
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
      companyId, callType: trigger.trigger_type,
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

// ── post_job_review (customer) — after a completed appointment ──────────────
// Delivery campaign: once a visit is completed, check in with the customer and
// collect a review. Fires once per job (dedup below includes completed calls).
async function processPostJobReview(companyId, trigger, callSettings, tz) {
  const cfg = trigger.trigger_config || {};
  const daysAfter = cfg.days_after ?? trigger.days_before ?? 1;

  const { rows } = await db.query(
    `SELECT DISTINCT ON (j.id)
            a.id AS appointment_id, j.id AS job_id,
            j.title AS job_name, j.description AS job_description, j.job_type,
            c.phone AS customer_phone, c.full_name AS customer_name,
            c.address_line1, c.city, c.state
     FROM appointments a
     JOIN jobs j      ON j.id = a.job_id
     JOIN customers c ON c.id = j.customer_id
     WHERE j.company_id = $1
       AND a.status = 'completed'
       AND a.updated_at >= NOW() - ($2 || ' days')::interval
     ORDER BY j.id, a.updated_at DESC`,
    [companyId, daysAfter]
  );

  logger.info(`Scheduler [post_job_review]: found ${rows.length} recently-completed appointment(s)`, { companyId, daysAfter });

  let c = 0, s = 0;
  for (const row of rows) {
    const jobId = String(row.job_id);
    if (!row.customer_phone) {
      await todosDb.createMissingPhone({
        companyId, jobId, subjectKind: "customer",
        subjectName: row.customer_name, callType: trigger.trigger_type,
        reason: "Customer phone number not provided — post-job review call could not be placed.",
        isTest: isDev,
      });
      s++; continue;
    }
    // Dedup: at most one review call per job, EVER (includes completed calls).
    const { rows: dup } = await db.query(
      `SELECT 1 FROM scheduled_calls
        WHERE company_id = $1 AND job_id = $2 AND call_type = $3 AND is_test = $4 LIMIT 1`,
      [companyId, jobId, trigger.trigger_type, isDev]
    );
    if (dup.length) { s++; continue; }

    const scheduledAt = isDev ? new Date() : snapToWindowStart(callSettings, tz, new Date());
    const inserted = await scheduleCall({
      companyId, callType: trigger.trigger_type,
      phoneNumber: row.customer_phone,
      jobId, jobDate: null, appointmentId: row.appointment_id,
      customerName: row.customer_name,
      customerAddress: [row.address_line1, row.city, row.state].filter(Boolean).join(", ") || null,
      jobName: row.job_name || null,
      jobDescription: row.job_description || null,
      jobType: row.job_type || null,
      scheduledAt, isTest: isDev, maxAttempts: callSettings.max_attempts,
      callPriority: computeInitialPriority({ triggerType: "post_job_review", jobDate: null, tz }),
    });
    if (inserted) c++; else s++;
  }
  return { c, s };
}

module.exports = { runDispatcher, runDailyJob, isWithinActiveHours, getNextWindowStart };
