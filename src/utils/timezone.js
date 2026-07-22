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

module.exports = {
  DEFAULT_TZ,
  getCompanyTimezone,
  localToUTC,
  toOffsetISOString,
  localizeFields,
  localizeRows,
  formatSpokenDate,
  formatSpokenDateTime,
  formatSpokenDateOnly,
};
