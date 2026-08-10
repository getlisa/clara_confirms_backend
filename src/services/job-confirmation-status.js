/**
 * Keep `jobs.status` in step with its appointments.
 *
 * Two derivations, in precedence order:
 *   completed — the job has appointments and every non-cancelled one is
 *               `completed`. Nothing is left to do.
 *   confirmed — EVERY upcoming appointment is customer-confirmed.
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
 * Per-job appointment tallies, shared by the single-job and whole-company
 * derivations so the two can't drift apart.
 *
 * `n_active` excludes cancelled visits: a job with two completed appointments
 * and one cancelled is finished, and a job whose appointments were ALL
 * cancelled is not "completed" (n_active = 0 fails the > 0 test).
 */
// "Outstanding" = booked but not yet completed or cancelled, REGARDLESS of
// whether it has started. Deliberately NOT the "upcoming" (scheduled_start >
// NOW()) definition used by job-confirmation-context.js and the confirmation
// sweep: those answer "who still needs a confirmation call?", where future-only
// is right. This answers "is this job's remaining work confirmed?", where it
// is not — a confirmed all-day visit that began an hour ago stops being
// "upcoming" the moment it starts, which silently dropped the job back to
// `scheduled` while the appointment was still running (reported on job 33286:
// customer_confirmed = true, visit 08:00-16:00, job showed `scheduled`).
const APPOINTMENT_TALLIES = `
  SELECT job_id,
         count(*) FILTER (WHERE status <> 'cancelled')                       AS n_active,
         count(*) FILTER (WHERE status =  'completed')                       AS n_completed,
         count(*) FILTER (WHERE status IN ('scheduled','confirmed','rescheduled'))
                                                                             AS n_outstanding,
         count(*) FILTER (WHERE status IN ('scheduled','confirmed','rescheduled')
                            AND COALESCE(customer_confirmed, false) = false) AS n_unconfirmed
    FROM appointments`;

// Precedence: completed wins. The two can't actually collide — an all-completed
// job has nothing upcoming — but ordering it first states the intent.
const DERIVED_STATUS = `
  CASE
    WHEN a.n_active   > 0 AND a.n_completed = a.n_active THEN 'completed'
    WHEN a.n_outstanding > 0 AND a.n_unconfirmed = 0     THEN 'confirmed'
    ELSE 'scheduled'
  END`;

// Statuses this module owns. 'open' (no appointments yet), 'in_progress' and
// 'cancelled' belong to other flows and must never be clobbered. 'completed'
// IS included so a job can move back out of it — if a new appointment is
// synced onto a finished job, leaving it stuck at 'completed' would hide it
// from the confirmation sweep, the same silent-miss this file already guards
// against for 'confirmed'.
const OWNED_STATUSES = `('scheduled', 'confirmed', 'completed')`;

/**
 * @returns {Promise<string|null>} the job's status after the recompute, or null
 *   when the job wasn't in a syncable status (see the guard below).
 */
async function syncJobConfirmationStatus(companyId, jobId) {
  const numericJobId = Number(jobId);
  if (!Number.isInteger(numericJobId) || numericJobId <= 0) return null;

  try {
    const { rows } = await db.query(
      `WITH a AS (
         ${APPOINTMENT_TALLIES}
          WHERE company_id = $1 AND job_id = $2
          GROUP BY job_id
       )
       UPDATE jobs j SET
         status = ${DERIVED_STATUS},
         updated_at = NOW()
        FROM a
        WHERE j.company_id = $1 AND j.id = $2
          AND j.status IN ${OWNED_STATUSES}
        RETURNING j.status`,
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

/**
 * Same derivation, whole company, one statement.
 *
 * Needed because normalize writes `jobs.status` straight from ServiceTrade's
 * own status on every sync (normalize.js mapJobStatus), which clobbers
 * anything derived here. So this has to re-run after each normalize, and
 * per-job round trips would be far too slow — a 500-job company at ~250ms per
 * round trip on a pooled connection is over two minutes for what is one
 * set-based UPDATE.
 *
 * Jobs with no appointments never appear in the tallies, so they're left
 * alone rather than being forced to 'scheduled'.
 *
 * @returns {Promise<number>} rows whose status actually changed
 */
async function syncAllJobStatuses(companyId) {
  try {
    const { rowCount } = await db.query(
      `WITH a AS (
         ${APPOINTMENT_TALLIES}
          WHERE company_id = $1
          GROUP BY job_id
       )
       UPDATE jobs j SET
         status = ${DERIVED_STATUS},
         updated_at = NOW()
        FROM a
        WHERE j.company_id = $1 AND j.id = a.job_id
          AND j.status IN ${OWNED_STATUSES}
          -- Skip no-op writes: without this every sync rewrites every job row
          -- (and its updated_at) even when nothing changed.
          AND j.status IS DISTINCT FROM ${DERIVED_STATUS}`,
      [companyId]
    );
    if (rowCount) logger.info("Job statuses derived from appointments", { companyId, changed: rowCount });
    return rowCount;
  } catch (err) {
    // Never fail a sync over this — the appointment data itself is already in.
    logger.warn("syncAllJobStatuses failed", { companyId, error: err.message });
    return 0;
  }
}

module.exports = { syncJobConfirmationStatus, syncAllJobStatuses };
