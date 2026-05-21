const db = require("./index");

async function create({ companyId, callType, phoneNumber, jobId, jobDate, customerName, technicianName, customerAddress, scheduledAt, isTest = false, maxAttempts = 3 }) {
  const result = await db.query(
    `INSERT INTO scheduled_calls
       (company_id, call_type, phone_number, job_id, job_date,
        customer_name, technician_name, customer_address,
        scheduled_at, is_test, max_attempts)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [companyId, callType, phoneNumber, jobId ?? null, jobDate ?? null,
     customerName ?? null, technicianName ?? null, customerAddress ?? null,
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

async function existsForJob(companyId, jobId, callType) {
  const result = await db.query(
    `SELECT 1 FROM scheduled_calls
     WHERE company_id = $1 AND job_id = $2 AND call_type = $3
       AND status NOT IN ('failed','cancelled') LIMIT 1`,
    [companyId, jobId, callType]
  );
  return result.rows.length > 0;
}

module.exports = { create, claimPending, markCompleted, markFailedOrRetry, advanceToNextWindow, existsForJob };
