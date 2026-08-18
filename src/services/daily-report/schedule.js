/**
 * Pure date/time logic for the daily report. No DB, no Date.now() default —
 * every function takes "now" as an argument, so the DST/midnight/catch-up
 * cases can be pinned exactly in tests rather than depending on when the test
 * happens to run.
 *
 * The rule (as agreed): a recipient's report always covers the last BUSINESS
 * DAY that had already finished at their chosen send time. Whether that's
 * "today" or "yesterday" depends only on how the recipient's chosen time
 * compares to the company's business_hours_end — it does not depend on what
 * day it happens to be when this function runs:
 *
 *   send_at_local >= business_hours_end  → today's day just finished  → report TODAY
 *   send_at_local <  business_hours_end  → today isn't finished yet   → report YESTERDAY
 *
 * Worked (business_hours_end = 17:00): 21:00 → today. 23:59 → today.
 * 01:00 → yesterday. 10:00 → yesterday (mid-day; today isn't over).
 */

const { localToUTC } = require("../../utils/timezone");

const HHMM = (t) => String(t).slice(0, 5); // 'HH:MM:SS' from pg TIME, or already 'HH:MM'

/** "Now", decomposed in `tz` — local calendar date, local HH:MM, and weekday (0=Sun). */
function localParts(nowUtc, tz) {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(nowUtc); // YYYY-MM-DD
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(nowUtc); // HH:MM
  const [y, m, d] = date.split("-").map(Number);
  // A calendar-only computation, deliberately done in UTC so the HOST server's
  // own timezone can never leak in — getUTCDay on a UTC-constructed date is
  // the weekday of that Y-M-D triple, full stop.
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun .. 6=Sat
  return { date, time, weekday };
}

/** 'YYYY-MM-DD' shifted by `delta` calendar days (delta may be negative). */
function addDays(dateStr, delta) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function isWeekend(dateStr) {
  const w = weekdayOf(dateStr);
  return w === 0 || w === 6;
}

/**
 * Which business day a recipient's report covers, given the local calendar
 * date "now" falls on. Independent of the current time-of-day — only the
 * recipient's chosen send time and the company's close time decide it.
 */
function computeTargetDate({ sendAtLocal, businessHoursEnd, todayLocal }) {
  return HHMM(sendAtLocal) >= HHMM(businessHoursEnd)
    ? todayLocal
    : addDays(todayLocal, -1);
}

/**
 * Should this recipient's report fire right now?
 *
 * `lastSentForDate` is compared to the BUSINESS DATE the report would cover,
 * not to today's date — this is what makes repeated sweep runs (every 15
 * minutes) a no-op after the first, and what makes a late catch-up run (the
 * cron was down at 21:00, recovers at 23:40) still send exactly once: the
 * condition "local time has passed send_at_local, and we haven't sent for this
 * target date yet" stays true until it's acted on.
 *
 * A weekend target date is skipped OUTRIGHT — not sent, not stamped — so nothing
 * is lost: Friday's unanswered outreach simply carries forward and appears in
 * Monday's "awaiting response" section once a real report is sent again.
 */
function resolveDue({ nowUtc, tz, sendAtLocal, businessHoursEnd, includeWeekends, lastSentForDate }) {
  const { date: todayLocal, time: nowTime } = localParts(nowUtc, tz);
  const targetDate = computeTargetDate({ sendAtLocal, businessHoursEnd, todayLocal });

  if (!includeWeekends && isWeekend(targetDate)) {
    return { due: false, targetDate, reason: "weekend" };
  }
  if (nowTime < HHMM(sendAtLocal)) {
    return { due: false, targetDate, reason: "not_yet_time" };
  }
  if (lastSentForDate === targetDate) {
    return { due: false, targetDate, reason: "already_sent" };
  }
  return { due: true, targetDate, reason: "due" };
}

/**
 * The business day's own [start, end) as UTC instants, for querying
 * TIMESTAMPTZ columns (occurred_at, created_at, updated_at) directly — the
 * report always means "this calendar day IN THE COMPANY'S OWN TIMEZONE", never
 * a UTC day, which would silently shift the boundary by hours.
 */
function businessDayRangeUtc(businessDate, tz) {
  return {
    from: localToUTC(`${businessDate}T00:00:00`, tz),
    to: localToUTC(`${addDays(businessDate, 1)}T00:00:00`, tz),
  };
}

module.exports = { localParts, addDays, isWeekend, weekdayOf, computeTargetDate, resolveDue, businessDayRangeUtc };
