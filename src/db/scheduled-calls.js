const db = require("./index");

/** Customer-facing call types — used for cross-trigger dedup on the same job. */
const CUSTOMER_CALL_TYPES = ["customer_confirmation", "quotation_followup"];

function quotationJobId(quotationId) {
  return `quotation:${quotationId}`;
}

/** Legacy keys still checked so existing rows dedupe correctly. */
function quotationDedupeKeys(quotationId, linkedJobId) {
  const keys = [quotationJobId(quotationId), `quotation_${quotationId}`];
  if (linkedJobId != null) keys.push(String(linkedJobId));
  return [...new Set(keys)];
}

async function create({ companyId, callType, phoneNumber, jobId, jobDate, appointmentId, customerName, technicianName, customerAddress, jobName, jobDescription, jobType, totalAmount, callContext, scheduledAt, isTest = false, maxAttempts = 3, callPriority, bypassOfficeHours }) {
  try {
    return await insertScheduledCall({ companyId, callType, phoneNumber, jobId, jobDate, appointmentId, customerName, technicianName, customerAddress, jobName, jobDescription, jobType, totalAmount, callContext, scheduledAt, isTest, maxAttempts, callPriority, bypassOfficeHours });
  } catch (err) {
    if (err.code === "23505") {
      const dup = new Error("Duplicate active scheduled call");
      dup.code = "DUPLICATE_SCHEDULED_CALL";
      throw dup;
    }
    throw err;
  }
}

async function insertScheduledCall({
  companyId, callType, phoneNumber, jobId, jobDate, appointmentId,
  customerName, technicianName, customerAddress,
  jobName, jobDescription, jobType, totalAmount, callContext,
  scheduledAt, isTest = false, maxAttempts = 3,
  callPriority = "normal", parentCallId = null, retryCount = 0,
  bypassOfficeHours = false,
}) {
  const result = await db.query(
    `INSERT INTO scheduled_calls
       (company_id, call_type, phone_number, job_id, job_date, appointment_id,
        customer_name, technician_name, customer_address,
        job_name, job_description, job_type, total_amount, call_context,
        scheduled_at, is_test, max_attempts,
        call_priority, parent_call_id, retry_count, bypass_office_hours)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,$19,$20,$21)
     RETURNING *`,
    [companyId, callType, phoneNumber, jobId ?? null, jobDate ?? null, appointmentId ?? null,
     customerName ?? null, technicianName ?? null, customerAddress ?? null,
     jobName ?? null, jobDescription ?? null, jobType ?? null, totalAmount ?? null,
     callContext ? JSON.stringify(callContext) : null,
     scheduledAt, isTest, maxAttempts,
     callPriority, parentCallId ?? null, retryCount, !!bypassOfficeHours]
  );
  return result.rows[0];
}

/**
 * Schedule a retry call for the next business day.
 * Only creates the retry if:
 *  - retry_count < MAX_RETRIES (3)
 *  - next retry date is before the job's due date
 *
 * Returns the new scheduled_call row, or null if retry not allowed.
 */
async function scheduleRetry(originalRow, nextWindowAt, jobDueDate, maxRetries = 3, tz = null) {
  if (originalRow.retry_count >= maxRetries) return null;
  if (jobDueDate && new Date(nextWindowAt) >= new Date(jobDueDate)) return null;

  const { computeRetryPriority } = require("../services/call-priority");
  const callPriority = computeRetryPriority(originalRow, tz);

  try {
    return await insertScheduledCall({
      companyId:       originalRow.company_id,
      callType:        originalRow.call_type,
      phoneNumber:     originalRow.phone_number,
      jobId:           originalRow.job_id,
      jobDate:         originalRow.job_date,
      appointmentId:   originalRow.appointment_id,
      customerName:    originalRow.customer_name,
      technicianName:  originalRow.technician_name,
      customerAddress: originalRow.customer_address,
      jobName:         originalRow.job_name,
      jobDescription:  originalRow.job_description,
      jobType:         originalRow.job_type,
      totalAmount:     originalRow.total_amount,
      scheduledAt:     nextWindowAt,
      isTest:          originalRow.is_test,
      maxAttempts:     originalRow.max_attempts,
      callPriority,
      parentCallId:    originalRow.id,
      retryCount:      originalRow.retry_count + 1,
    });
  } catch (err) {
    if (err.code === "DUPLICATE_SCHEDULED_CALL" || err.code === "23505") return null;
    throw err;
  }
}

/**
 * Schedule a callback at the time requested by the customer during the call.
 * callbackAt must be before jobDueDate.
 */
async function scheduleCallback(originalRow, callbackAt, jobDueDate) {
  if (jobDueDate && new Date(callbackAt) >= new Date(jobDueDate)) return null;

  try {
    return await insertScheduledCall({
      companyId:       originalRow.company_id,
      callType:        originalRow.call_type,
      phoneNumber:     originalRow.phone_number,
      jobId:           originalRow.job_id,
      jobDate:         originalRow.job_date,
      appointmentId:   originalRow.appointment_id,
      customerName:    originalRow.customer_name,
      technicianName:  originalRow.technician_name,
      customerAddress: originalRow.customer_address,
      jobName:         originalRow.job_name,
      jobDescription:  originalRow.job_description,
      jobType:         originalRow.job_type,
      totalAmount:     originalRow.total_amount,
      scheduledAt:     callbackAt,
      isTest:          originalRow.is_test,
      maxAttempts:     originalRow.max_attempts,
      callPriority:    "callback",
      parentCallId:    originalRow.id,
      retryCount:      0,
    });
  } catch (err) {
    if (err.code === "DUPLICATE_SCHEDULED_CALL" || err.code === "23505") return null;
    throw err;
  }
}

// ── Concurrency configuration ─────────────────────────────────────────────────
const MAX_CONCURRENT_CALLS    = 20;  // Retell standard-tier system-wide cap
const PER_TENANT_MIN_CONCURRENT = 2; // minimum guarantee, enforced as a floor on call_settings.max_concurrent_calls

const { priorityRank, PRIORITY_RANK_SQL_CASE } = require("../services/call-priority");
const { isWithinActiveHours, getNextWindowStart } = require("../services/office-hours");
const logger = require("../utils/logger");

/**
 * Claim due pending rows for dispatch.
 *
 * Concurrency model (replaces the old PRIORITY_RESERVED two-lane approach):
 *   - System-wide cap: MAX_CONCURRENT_CALLS (20). Hard ceiling.
 *   - Per-tenant cap:  GREATEST(call_settings.max_concurrent_calls, PER_TENANT_MIN_CONCURRENT).
 *     Each tenant can hold up to its cap in 'in_progress' simultaneously.
 *   - Priority ordering: callback < high < retry (legacy) < normal < low,
 *     ranked inside each tenant's allowed slice AND globally across the batch.
 *   - Dynamic boost: a tenant with spare cap absorbs system budget unused by
 *     idle tenants. When the system is saturated, the per-tenant cap shares fairly.
 *
 * @param {number} batchSize
 * @param {object} opts
 * @param {number} [opts.companyId]     — scope to one company (manual UI run)
 * @param {boolean} [opts.respectAutoFlag=true]
 *                                       — when true (system cron), claim only from
 *                                         companies with auto_dispatch_enabled = true.
 *                                         when false (manual), ignore the flag.
 */
async function claimPending(batchSize = 10, { companyId = null, respectAutoFlag = true } = {}) {
  // Reaper: any in_progress row stuck for >5 minutes is orphaned (crashed dispatcher,
  // function timeout, etc). Reset to pending so it gets retried on this run.
  await db.query(
    `UPDATE scheduled_calls
     SET status = 'pending', updated_at = NOW()
     WHERE status = 'in_progress'
       AND last_attempted_at < NOW() - INTERVAL '5 minutes'`
  );

  const scopeClause = companyId
    ? `AND sc.company_id = ${Number(companyId)}`
    : "";
  const autoClause = respectAutoFlag
    ? `AND EXISTS (
         SELECT 1 FROM call_settings cs2
         WHERE cs2.company_id = sc.company_id AND cs2.auto_dispatch_enabled = true
       )`
    : "";

  // ── Step A: which tenants have due rows, and are they in their office window?
  const { rows: candidates } = await db.query(
    `SELECT DISTINCT sc.company_id,
            c.default_timezone AS tz,
            cs.business_hours_start,
            cs.business_hours_end,
            COALESCE(cs.include_weekends, false) AS include_weekends
       FROM scheduled_calls sc
       JOIN companies c ON c.id = sc.company_id
       LEFT JOIN call_settings cs ON cs.company_id = sc.company_id
      WHERE sc.status = 'pending' AND sc.scheduled_at <= NOW()
        AND sc.bypass_office_hours = false
        ${scopeClause}`
  );

  const now = new Date();
  const inWindow    = [];
  const outOfWindow = [];
  for (const co of candidates) {
    if (co.business_hours_start && isWithinActiveHours(co, co.tz || "America/New_York", now)) {
      inWindow.push(co.company_id);
    } else {
      outOfWindow.push(co);
    }
  }

  // ── Step B: bulk-reschedule out-of-window rows to that tenant's next window.
  // Skip rows with bypass_office_hours=true (they must dial regardless).
  // Skip tenants with no business_hours configured (we don't know when to dial).
  for (const co of outOfWindow) {
    if (!co.business_hours_start) {
      logger.info("Dispatcher: tenant has no business_hours — pending rows will not dispatch", { companyId: co.company_id });
      continue;
    }
    const nextAt = getNextWindowStart(co, co.tz || "America/New_York", now);
    const updRes = await db.query(
      `UPDATE scheduled_calls
          SET scheduled_at = $2, updated_at = NOW()
        WHERE company_id = $1
          AND status = 'pending'
          AND scheduled_at <= NOW()
          AND bypass_office_hours = false
        RETURNING id`,
      [co.company_id, nextAt]
    );
    if (updRes.rowCount > 0) {
      logger.info("Dispatcher: rescheduled out-of-window rows", {
        companyId: co.company_id, count: updRes.rowCount, nextAt: nextAt.toISOString(),
      });
    }
  }

  // ── Step C: claim. Allow rows whose tenant is in-window OR whose bypass flag is true.
  // Single CTE-based claim:
  //   per_tenant_inflight — current in-progress count per tenant
  //   tenant_caps         — per-tenant max with floor PER_TENANT_MIN_CONCURRENT
  //   system_inflight     — total in-progress across all tenants
  //   due                 — pending rows due now, ranked within their tenant by priority then scheduled_at
  //   eligible            — rows whose tenant_rank fits inside (cap - in_flight)
  // The outer UPDATE applies the system-wide cap and batchSize to the priority-ordered list.
  const claimSql = `
    WITH per_tenant_inflight AS (
      SELECT company_id, COUNT(*)::int AS in_flight
      FROM scheduled_calls
      WHERE status = 'in_progress'
      GROUP BY company_id
    ),
    tenant_caps AS (
      SELECT cs.company_id,
             GREATEST(COALESCE(cs.max_concurrent_calls, 10), ${PER_TENANT_MIN_CONCURRENT}) AS cap
      FROM call_settings cs
    ),
    system_inflight AS (
      SELECT COUNT(*)::int AS n FROM scheduled_calls WHERE status = 'in_progress'
    ),
    due AS (
      SELECT sc.id, sc.company_id, sc.call_priority, sc.scheduled_at, sc.phone_number,
             ROW_NUMBER() OVER (
               PARTITION BY sc.company_id
               ORDER BY ${PRIORITY_RANK_SQL_CASE}, sc.scheduled_at ASC
             ) AS tenant_rank
      FROM scheduled_calls sc
      WHERE sc.status = 'pending'
        AND sc.scheduled_at <= NOW()
        AND (sc.company_id = ANY($2::int[]) OR sc.bypass_office_hours = true)
        ${scopeClause}
        ${autoClause}
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_calls busy
          WHERE busy.status = 'in_progress'
            AND busy.phone_number = sc.phone_number
        )
    ),
    eligible AS (
      SELECT d.id, d.call_priority, d.scheduled_at
      FROM due d
      LEFT JOIN per_tenant_inflight i ON i.company_id = d.company_id
      LEFT JOIN tenant_caps         c ON c.company_id = d.company_id
      WHERE d.tenant_rank <= GREATEST(0, COALESCE(c.cap, 10) - COALESCE(i.in_flight, 0))
    )
    UPDATE scheduled_calls
       SET status = 'in_progress', last_attempted_at = NOW(), updated_at = NOW()
     WHERE id IN (
       SELECT id FROM eligible
       ORDER BY ${PRIORITY_RANK_SQL_CASE}, scheduled_at ASC
       LIMIT LEAST(
         $1::int,
         GREATEST(0, ${MAX_CONCURRENT_CALLS} - (SELECT n FROM system_inflight))
       )
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *
  `;

  const { rows: claimed } = await db.query(claimSql, [batchSize, inWindow]);

  // Within this batch, dedupe by phone number — keep only the earliest-scheduled,
  // highest-priority call per phone. The rest go back to pending so the next
  // dispatcher tick can pick them up after the first one finishes.
  const seen = new Set();
  const winners = [];
  const losers  = [];
  const sorted = [...claimed].sort((a, b) => {
    const pr = priorityRank(a.call_priority) - priorityRank(b.call_priority);
    if (pr !== 0) return pr;
    return new Date(a.scheduled_at) - new Date(b.scheduled_at);
  });
  for (const row of sorted) {
    if (seen.has(row.phone_number)) { losers.push(row); continue; }
    seen.add(row.phone_number);
    winners.push(row);
  }

  if (losers.length > 0) {
    await db.query(
      `UPDATE scheduled_calls SET status = 'pending', updated_at = NOW()
       WHERE id = ANY($1::int[])`,
      [losers.map(r => r.id)]
    );
  }

  return winners;
}

async function markCompleted(id, retellCallId) {
  await db.query(
    `UPDATE scheduled_calls SET status = 'completed', retell_call_id = $2, updated_at = NOW() WHERE id = $1`,
    [id, retellCallId]
  );
}

async function markFailedOrRetry(id, reason) {
  const result = await db.query(
    `UPDATE scheduled_calls
     SET attempt_number = attempt_number + 1, failure_reason = $2,
         status = CASE WHEN attempt_number + 1 > max_attempts THEN 'failed' ELSE 'pending' END,
         scheduled_at = CASE WHEN attempt_number + 1 > max_attempts THEN scheduled_at ELSE NOW() + INTERVAL '5 minutes' END,
         updated_at = NOW()
     WHERE id = $1 RETURNING status`,
    [id, reason]
  );
  return result.rows[0]?.status;
}

async function advanceToNextWindow(id, nextWindowAt) {
  await db.query(
    `UPDATE scheduled_calls SET status = 'pending', scheduled_at = $2, updated_at = NOW() WHERE id = $1`,
    [id, nextWindowAt]
  );
}

/**
 * Returns true if a row already exists for this dedupe key.
 * Production: blocks pending, in_progress, completed, and cancelled (only `failed` allows re-schedule).
 * Preview: blocks only active queue rows.
 */
async function existsForJob(companyId, jobId, callType, isPreview = false) {
  const statusClause = isPreview
    ? `AND status IN ('pending','in_progress')`
    : `AND status NOT IN ('failed','cancelled', 'completed')`;
  const result = await db.query(
    `SELECT 1 FROM scheduled_calls
     WHERE company_id = $1 AND job_id = $2 AND call_type = $3
       ${statusClause}
     LIMIT 1`,
    [companyId, jobId, callType]
  );
  return result.rows.length > 0;
}

/** Quotation dedupe across quotation:id, legacy quotation_N, and linked job id. */
async function existsForQuotation(companyId, quotationId, linkedJobId, callType, isPreview = false) {
  for (const key of quotationDedupeKeys(quotationId, linkedJobId)) {
    if (await existsForJob(companyId, key, callType, isPreview)) return true;
  }
  return false;
}

/**
 * Customer triggers (cases 1–3): skip if this call type or another customer call type
 * is already scheduled for the same job.
 */
async function existsForCustomerJob(companyId, jobId, callType, isPreview = false) {
  if (await existsForJob(companyId, jobId, callType, isPreview)) return true;
  for (const ct of CUSTOMER_CALL_TYPES) {
    if (ct !== callType && (await existsForJob(companyId, jobId, ct, isPreview))) return true;
  }
  return false;
}

module.exports = {
  CUSTOMER_CALL_TYPES,
  MAX_CONCURRENT_CALLS,
  PER_TENANT_MIN_CONCURRENT,
  quotationJobId,
  create,
  claimPending,
  markCompleted,
  markFailedOrRetry,
  advanceToNextWindow,
  scheduleRetry,
  scheduleCallback,
  existsForJob,
  existsForQuotation,
  existsForCustomerJob,
};
