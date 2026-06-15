/**
 * Parse a natural-language callback time from the customer into a Date.
 *
 * Used by:
 *   - Post-call analysis path (src/routes/retell.js) — Retell extracts a string
 *     like "1pm" or "in 30 minutes" from the transcript and we parse it here.
 *   - Live tool path (src/routes/retell-tools.js → POST /retell/tools/schedule_callback)
 *     — the agent invokes the tool mid-call with a callback_time argument.
 *
 * Handles:
 *   - "1pm" / "2:30 PM" / "14:00"            → today at that time in company tz
 *   - "in 30 minutes" / "in an hour"          → now + duration
 *   - ISO strings (passed directly by agent)  → parsed as-is
 *
 * Returns null if the string cannot be interpreted.
 */
function parseCallbackTime(callbackTime, tz) {
  if (!callbackTime) return null;
  const s = String(callbackTime).trim().toLowerCase();

  // ISO format from agent (most reliable)
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  const now = new Date();

  // "in X minutes / hours"
  const relMatch = s.match(/in\s+(\d+|an?)\s+(minute|hour)/i);
  if (relMatch) {
    const qty = relMatch[1] === "a" || relMatch[1] === "an" ? 1 : parseInt(relMatch[1], 10);
    const unit = relMatch[2].startsWith("hour") ? 60 : 1;
    return new Date(now.getTime() + qty * unit * 60 * 1000);
  }

  // "1pm", "2:30 PM", "14:00" — today in company timezone
  const timeMatch = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (timeMatch) {
    let hour = parseInt(timeMatch[1], 10);
    const min = parseInt(timeMatch[2] ?? "0", 10);
    const meridiem = (timeMatch[3] || "").toLowerCase();
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    // Build local datetime string in company timezone, then convert to UTC.
    const todayLocal = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    const localDt = `${todayLocal}T${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;

    // Iterate to handle DST correctly (same approach as localToUTC in retell-tools.js).
    const naive = new Date(localDt + "Z");
    const fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    let u = naive;
    for (let i = 0; i < 3; i++) {
      const localOfU = new Date(fmt.format(u) + "Z");
      const diff = naive.getTime() - localOfU.getTime();
      if (Math.abs(diff) < 1000) break;
      u = new Date(u.getTime() + diff);
    }
    return u;
  }

  return null;
}

module.exports = { parseCallbackTime };
