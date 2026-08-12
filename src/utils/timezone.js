/**
 * Single source of truth for company-timezone resolution and conversion.
 *
 * Policy: the DB stores everything in UTC (every time-of-day column is
 * TIMESTAMPTZ — Postgres normalizes these to UTC internally regardless of
 * session timezone). Every value that leaves the server toward a client must
 * be converted to the company's effective timezone (companies.default_timezone
 * — kept in sync with the connected CRM's account timezone, see
 * src/services/servicetrade-account.js) — never raw UTC.
 *
 * Two output contracts for two different consumers:
 *   - REST/frontend APIs  → toOffsetISOString / localizeFields / localizeRows
 *     ("2024-01-04T08:15:00-05:00" — machine-parseable, DST-correct, sortable)
 *   - Retell voice-agent tools → formatSpokenDate / formatSpokenDateTime
 *     ("Thursday, January 4, 2024 at 8:15 AM" — meant to be read aloud)
 * Both REPLACE the raw UTC value; never both alongside each other.
 */

const db = require("../db");

const DEFAULT_TZ = "America/New_York";

/**
 * Resolve a company's effective timezone (kept in sync with the connected
 * CRM by src/services/servicetrade-account.js; falls back to the platform
 * default when no CRM is connected).
 * @param {number|string} companyId
 * @returns {Promise<string>} IANA timezone name
 */
async function getCompanyTimezone(companyId) {
  try {
    const { rows } = await db.query(
      "SELECT default_timezone FROM companies WHERE id = $1",
      [companyId]
    );
    return rows[0]?.default_timezone || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

/**
 * Convert a naive local datetime string (no timezone suffix) in a given
 * timezone to a proper UTC ISO string — for WRITE paths (a client/agent
 * supplies a wall-clock time meant in the company's timezone; this is what
 * must be stored in a TIMESTAMPTZ column).
 *
 * e.g. "2026-05-28T10:00:00" in "America/New_York" → "2026-05-28T14:00:00.000Z"
 *
 * Uses an iterative correction approach so DST transitions are handled correctly.
 */
function localToUTC(dateTimeStr, timezone) {
  // Normalise: ensure we have seconds, strip any existing Z/offset
  const clean = dateTimeStr.replace(/Z$|[+-]\d{2}:?\d{2}$/, "").padEnd(19, ":00").slice(0, 19);

  // Treat as UTC initially
  const naive = new Date(clean + "Z");

  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  // Iterate up to 3 times — converges in 1 pass for standard offsets, 2 at DST boundary
  let u = naive;
  for (let i = 0; i < 3; i++) {
    const localOfU = new Date(fmt.format(u) + "Z");
    const diff = naive.getTime() - localOfU.getTime();
    if (Math.abs(diff) < 1000) break;
    u = new Date(u.getTime() + diff);
  }
  return u.toISOString();
}

/**
 * Convert a UTC Date/ISO-string into an ISO-8601 string carrying the correct
 * numeric UTC offset for that instant in the given timezone — for READ paths
 * (REST/frontend API responses). e.g.:
 *   toOffsetISOString("2025-11-19T17:20:00.000Z", "America/New_York")
 *     → "2025-11-19T12:20:00-05:00"
 * Represents the exact same instant as the input — a correct `new Date(...)`
 * re-parse yields an identical timestamp; only the displayed offset/components differ.
 * Returns null for null/undefined/invalid input.
 *
 * ONLY for TIMESTAMPTZ-backed values (a real point-in-time with a time-of-day).
 * Never call this (or localizeFields/localizeRows) on a DATE-only column (e.g.
 * jobs.scheduled_date, quotations.valid_until) — node-postgres returns those as
 * a JS Date at UTC midnight, and applying a negative-offset timezone would shift
 * the displayed calendar day backward by one. DATE columns have no time-of-day/
 * timezone ambiguity to resolve; leave them as the plain date string they are.
 */
function toOffsetISOString(input, tz) {
  if (input == null) return null;
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return null;

  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    timeZoneName: "longOffset",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  // parts.timeZoneName is like "GMT-05:00", "GMT+05:30", or "GMT" for zero offset
  const offset = parts.timeZoneName === "GMT" ? "+00:00" : parts.timeZoneName.replace("GMT", "");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

/**
 * Replace named timestamp fields on a shallow-copied object with their
 * offset-ISO equivalents (REST/frontend contract). Fields not present or
 * null/undefined are left untouched. Does not mutate the input.
 * @param {object} row
 * @param {string} tz
 * @param {string[]} fields
 */
function localizeFields(row, tz, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    if (out[f] != null) out[f] = toOffsetISOString(out[f], tz);
  }
  return out;
}

/** Same as localizeFields, applied to every row in an array. */
function localizeRows(rows, tz, fields) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => localizeFields(r, tz, fields));
}

/**
 * Human-readable, spoken-form date — for the Retell voice agent to read aloud.
 * Requires `tz` so the agent always states the company's/CRM's local time
 * instead of the server process's local time.
 */
function formatSpokenDate(iso, tz) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/** Human-readable, spoken-form date+time — see formatSpokenDate. */
function formatSpokenDateTime(iso, tz) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Time of day only, e.g. "8:00 AM" — for arrival windows, where the date is already stated. */
function formatSpokenTime(iso, tz) {
  if (!iso) return null;
  return new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" });
}

/**
 * Friendly name for a timezone, e.g. "Central Time" — for telling a customer
 * which zone a time is in.
 *
 * Derived from the company's own `default_timezone`, never hardcoded: the
 * companies on this platform sit in America/New_York, America/Chicago and
 * America/Vancouver, so a fixed "Central Time" would misstate a real
 * appointment by up to three hours for two thirds of them.
 *
 * Falls back to the raw IANA name rather than guessing, so a zone we have no
 * label for reads as "America/Halifax time" — clumsy but never wrong.
 */
function timezoneLabel(tz) {
  if (!tz) return null;
  try {
    // The runtime already knows these names; asking it avoids maintaining a map
    // that silently rots as zones change.
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "long" })
      .formatToParts(new Date());
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    // "Central Daylight Time" / "Central Standard Time" -> "Central Time": the
    // customer does not need to be told which half of the year it is.
    if (name) return name.replace(/\b(Standard|Daylight|Summer)\s+/i, "");
  } catch {
    /* unknown zone — fall through */
  }
  return `${tz} time`;
}

/**
 * The arrival window for a scheduled start, as "between 8 AM and 9 AM".
 *
 * FORWARD-LOOKING, not centred: the window runs from the scheduled time to
 * `minutes` after it, so an 8 AM visit is "between 8 AM and 9 AM" and a 9 AM
 * visit is "between 9 AM and 10 AM". It previously straddled the start (±30),
 * which told a customer the crew might turn up BEFORE the time they were given
 * — the opposite of how a service window is normally promised.
 *
 * Computed rather than left to the agent: a model doing this arithmetic in its
 * head gets hour and noon boundaries wrong (11:30 AM plus an hour is 12:30 PM,
 * crossing meridiem; 11:30 PM crosses midnight). Both bounds are formatted from
 * real Date arithmetic in the company's timezone, so DST transitions and
 * midnight crossings are handled by the formatter rather than by guesswork.
 */
function formatArrivalWindow(iso, tz, minutes = 60) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  // A whole hour reads as "8 AM", not "8:00 AM" — the window is nearly always
  // on the hour, and the text-to-speech voice says the trailing ":00" out loud.
  const trim = (s) => (s ? s.replace(/:00(?=\s)/, "") : s);
  const from = trim(formatSpokenTime(new Date(t).toISOString(), tz));
  const to = trim(formatSpokenTime(new Date(t + minutes * 60_000).toISOString(), tz));
  if (!from || !to) return null;
  // On a DST fall-back night the same wall-clock time occurs twice, so both
  // bounds can format identically — "between 1:00 AM and 1:00 AM" is worse than
  // saying nothing. Callers fall back to stating the scheduled time alone.
  if (from === to) return null;
  return `between ${from} and ${to}`;
}

/**
 * Human-readable spoken form for a DATE-only value (e.g. jobs.scheduled_date —
 * no time-of-day/timezone component at all). Deliberately does NOT take a `tz`
 * and always formats in UTC: node-postgres returns a DATE column as a JS Date
 * at UTC midnight for that calendar day, so applying any OTHER timezone (e.g.
 * a negative-offset one like America/New_York) would shift the displayed day
 * backward by one — "2024-01-04" would wrongly read as "January 3". A DATE has
 * no ambiguity to resolve; the calendar day is the calendar day.
 */
function formatSpokenDateOnly(dateOnly) {
  if (!dateOnly) return null;
  return new Date(dateOnly).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

/**
 * The calendar day a timestamp falls on IN `tz`, as "YYYY-MM-DD" — for writing
 * an instant into a DATE column.
 *
 * Letting Postgres cast the timestamp instead would truncate it in the session
 * timezone (UTC here), so an 8pm America/Chicago appointment (01:00 UTC next
 * day) would land on the FOLLOWING calendar day. That matters wherever a DATE
 * gates scheduling — `scheduled_calls.job_date` is compared against retry and
 * callback windows, so a day-late value can allow a retry after the appointment
 * has already happened.
 */
function toLocalDateOnly(input, tz) {
  if (input == null) return null;
  const date = input instanceof Date ? input : new Date(input);
  if (isNaN(date.getTime())) return null;
  // en-CA renders as YYYY-MM-DD, which is exactly the DATE literal Postgres wants.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz || DEFAULT_TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

module.exports = {
  formatSpokenTime,
  formatArrivalWindow,
  timezoneLabel,
  DEFAULT_TZ,
  getCompanyTimezone,
  localToUTC,
  toOffsetISOString,
  toLocalDateOnly,
  localizeFields,
  localizeRows,
  formatSpokenDate,
  formatSpokenDateTime,
  formatSpokenDateOnly,
};
