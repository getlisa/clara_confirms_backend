/**
 * Shared ?startDate/?endDate validation for every CRM's custom-range sync
 * route (routes/servicetrade.js, routes/inspectpoint.js). Only the
 * calendar-date validation lives here — turning a validated {startDate,
 * endDate} pair into whatever unix-second window a specific CRM's API
 * actually wants is each route's own job, since that conversion differs per
 * CRM (ServiceTrade's /job filter wants company-local time; InspectPoint's
 * scheduled_date_start/end is a plain date with no timezone component, same
 * convention its own rolling window already uses).
 */

/**
 * Longest custom sync window accepted, in inclusive days. 31 so that any
 * single calendar month is always a valid range (2026-07-01..2026-07-31),
 * while a wider pull still has to go through full=true.
 */
const MAX_SYNC_RANGE_DAYS = 31;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar date — rejects 2026-02-30, 2026-13-01, etc. */
function isCalendarDate(str) {
  if (!DATE_RE.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Validate a ?startDate/?endDate (YYYY-MM-DD) pair. Returns:
 *   - { error } on bad input (caller turns it into a 400)
 *   - {} when neither param was given (the caller's default window stays in effect)
 *   - { startDate, endDate } once both are confirmed real calendar dates,
 *     endDate >= startDate, spanning at most MAX_SYNC_RANGE_DAYS days, and
 *     not combined with full=true (the two are contradictory: full drops any
 *     date window entirely).
 *
 * Bad input is rejected rather than silently defaulted — a backfill that
 * quietly syncs the wrong month is worse than one that fails loudly.
 */
function validateSyncRange({ startDate, endDate, full }) {
  if (!startDate && !endDate) return {};
  if (!startDate || !endDate) {
    return { error: "startDate and endDate must be provided together" };
  }
  if (!isCalendarDate(startDate) || !isCalendarDate(endDate)) {
    return { error: "Invalid date: expected YYYY-MM-DD" };
  }
  if (endDate < startDate) {
    return { error: "endDate must be on or after startDate" };
  }
  // Day span is counted on the plain date strings, in UTC — a DST transition
  // shifts wall-clock hours, never the number of calendar days between two
  // dates, so this must NOT be derived from either CRM's converted epochs.
  const spanDays =
    (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000 + 1;
  if (spanDays > MAX_SYNC_RANGE_DAYS) {
    return { error: `Date range cannot exceed ${MAX_SYNC_RANGE_DAYS} days` };
  }
  if (full) {
    return { error: "full=true cannot be combined with a custom date range" };
  }
  return { startDate, endDate };
}

module.exports = { MAX_SYNC_RANGE_DAYS, isCalendarDate, validateSyncRange };
