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

async function insertScheduledCall({ companyId, callType, phoneNumber, jobId, jobDate, appointmentId, customerName, technicianName, customerAddress, jobName, jobDescription, jobType, totalAmount, scheduledAt, isTest = false, maxAttempts = 3 }) {
  const result = await db.query(
    `INSERT INTO scheduled_calls
       (company_id, call_type, phone_number, job_id, job_date, appointment_id,
        customer_name, technician_name, customer_address,
        job_name, job_description, job_type, total_amount,
        scheduled_at, is_test, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [companyId, callType, phoneNumber, jobId ?? null, jobDate ?? null, appointmentId ?? null,
     customerName ?? null, technicianName ?? null, customerAddress ?? null,
     jobName ?? null, jobDescription ?? null, jobType ?? null, totalAmount ?? null,
     scheduledAt, isTest, maxAttempts]
  );
  return result.rows[0];
}

async function claimPending(limit = 10) {
  const result = await db.query(
    `UPDATE scheduled_calls SET status = 'in_progress', last_attempted_at = NOW(), updated_at = NOW()
     WHERE id IN (
       SELECT id FROM scheduled_calls
       WHERE status = 'pending' AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [limit]
  );
  return result.rows;
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
  quotationJobId,
  create,
  claimPending,
  markCompleted,
  markFailedOrRetry,
  advanceToNextWindow,
  existsForJob,
  existsForQuotation,
  existsForCustomerJob,
};
