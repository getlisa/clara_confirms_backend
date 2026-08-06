/**
 * Keep `jobs.status` in step with per-appointment confirmations.
 *
 * A job is `confirmed` only when EVERY upcoming appointment on it is
 * customer-confirmed. Confirming one of three visits leaves the job
 * `scheduled` — the previous behaviour (flip on the first confirmation,
 * routes/jobs.js) reported a job as confirmed while two visits were still
 * unconfirmed.
 *
 * The reverse transition matters just as much: a job left stuck at `confirmed`
 * is excluded by the confirmation sweep's `j.status IN ('scheduled','rescheduled')`
 * filter, so a newly synced or rescheduled appointment on it would never get a
 * confirmation call — a silent miss that only surfaces weeks later. Calling this
 * after any appointment change keeps that from happening.
 *
 * "Upcoming" is defined identically here and in job-confirmation-context.js
 * (status IN ('scheduled','confirmed','rescheduled') AND scheduled_start in the
 * future); the two must stay in sync.
 */

const db = require("./../db");
const logger = require("../utils/logger");

/**
 * @returns {Promise<string|null>} the job's status after the recompute, or null
 *   when the job wasn't in a syncable status (see the guard below).
 */
async function syncJobConfirmationStatus(companyId, jobId) {
  const numericJobId = Number(jobId);
  if (!Number.isInteger(numericJobId) || numericJobId <= 0) return null;

  try {
    const { rows } = await db.query(
      `WITH upcoming AS (
         SELECT COALESCE(customer_confirmed, false) AS confirmed
           FROM appointments
          WHERE company_id = $1 AND job_id = $2
            AND status IN ('scheduled', 'confirmed', 'rescheduled')
            AND scheduled_start > NOW()
       )
       UPDATE jobs SET
         status = CASE
           WHEN (SELECT count(*) FROM upcoming) > 0
            AND NOT EXISTS (SELECT 1 FROM upcoming WHERE confirmed = false)
           THEN 'confirmed'
           ELSE 'scheduled'
         END,
         updated_at = NOW()
        WHERE company_id = $1 AND id = $2
          -- Only these two are ours to move. 'open' (no appointments yet),
          -- 'in_progress', 'completed' and 'cancelled' are owned by other flows
          -- and must never be clobbered by a confirmation.
          AND status IN ('scheduled', 'confirmed')
        RETURNING status`,
      [companyId, numericJobId]
    );
    const status = rows[0]?.status ?? null;
    if (status) logger.info("Job confirmation status synced", { companyId, jobId: numericJobId, status });
    return status;
  } catch (err) {
    // Never fail the caller's confirmation over a status recompute — the
    // confirmation itself is already persisted by that point.
    logger.warn("syncJobConfirmationStatus failed", { companyId, jobId: numericJobId, error: err.message });
    return null;
  }
}

module.exports = { syncJobConfirmationStatus };
