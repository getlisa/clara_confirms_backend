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

async function create({ companyId, callType, phoneNumber, jobId, jobDate, appointmentId, customerName, technicianName, customerAddress, jobName, jobDescription, jobType, totalAmount, scheduledAt, isTest = false, maxAttempts = 3 }) {
  try {
    return await insertScheduledCall({ companyId, callType, phoneNumber, jobId, jobDate, appointmentId, customerName, technicianName, customerAddress, jobName, jobDescription, jobType, totalAmount, scheduledAt, isTest, maxAttempts });
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
  jobName, jobDescription, jobType, totalAmount,
  scheduledAt, isTest = false, maxAttempts = 3,
  callPriority = "normal", parentCallId = null, retryCount = 0,
}) {
  const result = await db.query(
    `INSERT INTO scheduled_calls
       (company_id, call_type, phone_number, job_id, job_date, appointment_id,
        customer_name, technician_name, customer_address,
        job_name, job_description, job_type, total_amount,
        scheduled_at, is_test, max_attempts,
        call_priority, parent_call_id, retry_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     RETURNING *`,
    [companyId, callType, phoneNumber, jobId ?? null, jobDate ?? null, appointmentId ?? null,
     customerName ?? null, technicianName ?? null, customerAddress ?? null,
     jobName ?? null, jobDescription ?? null, jobType ?? null, totalAmount ?? null,
     scheduledAt, isTest, maxAttempts,
     callPriority, parentCallId ?? null, retryCount]
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
async function scheduleRetry(originalRow, nextWindowAt, jobDueDate, maxRetries = 3) {
  if (originalRow.retry_count >= maxRetries) return null;
  if (jobDueDate && new Date(nextWindowAt) >= new Date(jobDueDate)) return null;

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
      callPriority:    "retry",
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
const MAX_CONCURRENT_CALLS = 20;  // total in-flight cap
const PRIORITY_RESERVED    = 5;   // slots always available for retry/callback

/**
 * Claim due pending calls respecting priority lanes and concurrency limits.
 *
 * Slots:
 *   - Total cap: MAX_CONCURRENT_CALLS (20)
 *   - PRIORITY_RESERVED (5) are always reserved for retry/callback calls
 *   - Normal calls can only use the remaining (20 - 5 = 15) slots
 *
 * Priority (retry/callback) calls can use any available slot up to the full cap.
 * Normal calls can only use slots when in_flight < 15.
 */
async function claimPending(batchSize = 10) {
  const { rows: [{ in_flight }] } = await db.query(
    `SELECT COUNT(*)::int AS in_flight FROM scheduled_calls WHERE status = 'in_progress'`
  );

  const totalAvailable    = Math.max(0, MAX_CONCURRENT_CALLS - in_flight);
  const normalAvailable   = Math.max(0, (MAX_CONCURRENT_CALLS - PRIORITY_RESERVED) - in_flight);
  const priorityAvailable = totalAvailable; // priority can use any free slot

  if (totalAvailable === 0) return [];

  // Same-person dedup: skip any row whose phone_number is already in_progress.
  // This prevents two calls being placed to the same person simultaneously —
  // the second call waits in 'pending' until the first one completes/fails.
  const busyPhoneFilter = `
    AND NOT EXISTS (
      SELECT 1 FROM scheduled_calls busy
      WHERE busy.status = 'in_progress'
        AND busy.phone_number = scheduled_calls.phone_number
    )
  `;

  // Claim priority calls first (retry/callback), then normal — both respect SKIP LOCKED
  const result = await db.query(
    `UPDATE scheduled_calls SET status = 'in_progress', last_attempted_at = NOW(), updated_at = NOW()
     WHERE id IN (
       -- Priority lane: retry + callback calls (5 reserved slots)
       (SELECT id FROM scheduled_calls
        WHERE status = 'pending' AND scheduled_at <= NOW()
          AND call_priority IN ('retry','callback')
          ${busyPhoneFilter}
        ORDER BY call_priority DESC, scheduled_at ASC  -- callback before retry
        LIMIT $1 FOR UPDATE SKIP LOCKED)

       UNION ALL

       -- Normal lane (limited to non-reserved slots)
       (SELECT id FROM scheduled_calls
        WHERE status = 'pending' AND scheduled_at <= NOW()
          AND call_priority = 'normal'
          ${busyPhoneFilter}
        ORDER BY scheduled_at ASC
        LIMIT $2 FOR UPDATE SKIP LOCKED)

       LIMIT $3
     ) RETURNING *`,
    [
      Math.min(priorityAvailable, batchSize),
      Math.min(normalAvailable,   batchSize),
      Math.min(totalAvailable,    batchSize),
    ]
  );

  // Within this batch, also dedup by phone number — keep only the earliest-scheduled
  // call per phone (priority > normal, then scheduled_at ASC). The rest go back to pending.
  const claimed = result.rows;
  const seen = new Set();
  const winners = [];
  const losers  = [];
  // Sort so winners come first: priority first, then earliest scheduled
  const priorityRank = { callback: 0, retry: 1, normal: 2 };
  const sorted = [...claimed].sort((a, b) => {
    const pa = priorityRank[a.call_priority] ?? 2;
    const pb = priorityRank[b.call_priority] ?? 2;
    if (pa !== pb) return pa - pb;
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
    : `AND status NOT IN ('failed','cancelled')`;
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
  PRIORITY_RESERVED,
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
