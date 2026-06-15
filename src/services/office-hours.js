/**
 * Office-hours helpers.
 *
 * Extracted from src/services/scheduler.js so src/db/scheduled-calls.js can
 * import them without a circular dependency (scheduler.js → claimPending →
 * office-hours.js is acyclic; if office-hours lived in scheduler.js, the
 * cycle would close).
 *
 * "Settings" param shape (compatible with both call_settings and the
 * pre-extracted helpers):
 *   {
 *     business_hours_start: "HH:MM",   // local time in tz
 *     business_hours_end:   "HH:MM",
 *     include_weekends:     boolean,
 *   }
 */

function toLocalHHMM(date, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
    return `${(p.find(x => x.type === "hour")?.value ?? "00").padStart(2,"0")}:${(p.find(x => x.type === "minute")?.value ?? "00").padStart(2,"0")}`;
  } catch { return "12:00"; }
}

function toLocalDayOfWeek(date, tz) {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).formatToParts(date);
    return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.find(x => x.type === "weekday")?.value);
  } catch { return date.getDay(); }
}

function isWithinActiveHours(s, tz, date = new Date()) {
  const day = toLocalDayOfWeek(date, tz);
  if (!s.include_weekends && (day === 0 || day === 6)) return false;
  const now = toLocalHHMM(date, tz);
  return now >= s.business_hours_start && now < s.business_hours_end;
}

function getNextWindowStart(s, tz, from = new Date()) {
  const c = new Date(from); c.setSeconds(0, 0); c.setMinutes(c.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 7; i++) {
    if (isWithinActiveHours(s, tz, c)) return c;
    c.setMinutes(c.getMinutes() + 1);
  }
  return new Date(from.getTime() + 86_400_000);
}

function snapToWindowStart(s, tz, targetDate) {
  const [h, m] = s.business_hours_start.split(":").map(Number);
  const c = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(targetDate) + `T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:00`);
  if (c <= new Date()) return getNextWindowStart(s, tz, new Date());
  const day = toLocalDayOfWeek(c, tz);
  if (!s.include_weekends && (day === 0 || day === 6)) return getNextWindowStart(s, tz, c);
  return c;
}

function formatDateInTz(date, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(date);
  } catch {
    return date.toISOString().split("T")[0];
  }
}

module.exports = {
  toLocalHHMM,
  toLocalDayOfWeek,
  isWithinActiveHours,
  getNextWindowStart,
  snapToWindowStart,
  formatDateInTz,
};
