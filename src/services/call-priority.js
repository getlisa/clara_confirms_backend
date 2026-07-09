/**
 * Call-priority assignment helpers.
 *
 * `scheduled_calls.call_priority` is a VARCHAR with values (highest → lowest):
 *
 *   'callback'  user-requested callback at a specific time. Always wins.
 *   'high'      due today, or manually-triggered "Call now".
 *   'retry'     legacy value for rows inserted before this module existed.
 *               No longer assigned anywhere new; kept in the ranking so
 *               pre-existing rows still sort sensibly.
 *   'normal'    default — tomorrow's appointment, technician confirmations.
 *   'low'       open jobs ≥3 days out, quotation follow-ups.
 *
 * Used both server-side (computing priority at insert time) and inside the
 * claimPending SQL via PRIORITY_RANK_SQL_CASE (a SQL CASE expression with the
 * same numeric ordering).
 */

const PRIORITY_RANK = Object.freeze({
  callback: 0,
  high:     1,
  retry:    2, // legacy
  normal:   3,
  low:      4,
});

/** Returns lower = higher priority. Used by JS sort() and SQL ORDER BY. */
function priorityRank(p) {
  return PRIORITY_RANK[p] ?? 5;
}

/**
 * SQL CASE expression returning the same numeric ranking as priorityRank().
 * Inline into ORDER BY / WHERE clauses inside claimPending so we don't need a
 * Postgres user-defined function (and the migration footprint stays at zero).
 */
const PRIORITY_RANK_SQL_CASE = `
  CASE call_priority
    WHEN 'callback' THEN 0
    WHEN 'high'     THEN 1
    WHEN 'retry'    THEN 2
    WHEN 'normal'   THEN 3
    WHEN 'low'      THEN 4
    ELSE 5
  END
`;

/**
 * Number of whole days between today (in the given tz) and the supplied date.
 * Negative → date is in the past. 0 → date is today.
 *
 * jobDate can be a Date, a date-only string ('2026-06-15'), or a full ISO ts.
 * We extract just the date part in the company tz so callback hour-of-day
 * variations don't bleed across day boundaries.
 */
function daysUntilInTz(jobDate, tz) {
  if (!jobDate) return Infinity;
  const target = typeof jobDate === "string" ? new Date(jobDate) : jobDate;
  if (Number.isNaN(target?.getTime?.())) return Infinity;

  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const todayStr  = fmt.format(new Date());            // "2026-06-12"
  const targetStr = fmt.format(target);                // "2026-06-15"
  const [ty, tm, td] = todayStr.split("-").map(Number);
  const [jy, jm, jd] = targetStr.split("-").map(Number);
  // Compare via UTC midnight of each date — both dates are tz-naive here.
  const todayUtc  = Date.UTC(ty, tm - 1, td);
  const targetUtc = Date.UTC(jy, jm - 1, jd);
  return Math.round((targetUtc - todayUtc) / 86_400_000);
}

/**
 * Compute the priority for a newly-scheduled call.
 *
 * @param {object} args
 * @param {string} args.triggerType  — scheduled_unconfirmed | technician_unconfirmed | open_job_due_soon | quotation_pending
 * @param {Date|string|null} args.jobDate
 * @param {string} args.tz
 * @param {boolean} [args.isManual=false] — true for POST /calls/manual
 * @returns {'callback'|'high'|'normal'|'low'}
 */
function computeInitialPriority({ triggerType, jobDate, tz, isManual = false }) {
  if (isManual) return "high";
  if (triggerType === "quotation_pending") return "low";
  if (triggerType === "post_job_review") return "low";

  const days = daysUntilInTz(jobDate, tz);
  if (days === 0) return "high";

  if (triggerType === "open_job_due_soon") {
    return days >= 3 ? "low" : "normal";
  }
  return "normal";
}

/**
 * Compute the priority for a retry of an existing scheduled_calls row.
 * If the underlying job is still today, escalate to 'high' — we're running out
 * of time. Otherwise the retry sits at 'normal' so it doesn't crowd out fresh
 * HIGH-priority work for the same tenant.
 */
function computeRetryPriority(originalRow, tz) {
  if (originalRow?.job_date && daysUntilInTz(originalRow.job_date, tz) === 0) {
    return "high";
  }
  return "normal";
}

module.exports = {
  priorityRank,
  PRIORITY_RANK_SQL_CASE,
  daysUntilInTz,
  computeInitialPriority,
  computeRetryPriority,
};
