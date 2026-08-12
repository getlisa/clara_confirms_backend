const db = require("./src/db");

/**
 * Pull a recurrence phrase out of a service description, or null.
 * Deterministic on purpose: the description itself is NEVER passed to the model
 * (it leaks long equipment text into a short comment), so this extracts just the
 * cadence and hands that over as a fact.
 */
const RECURRENCE_PATTERNS = [
  [/\bsemi[-\s]?annual(?:ly)?\b/i, "semi-annual"],
  [/\bbi[-\s]?annual(?:ly)?\b/i, "bi-annual"],
  [/\bannual(?:ly)?\b/i, "annual"],
  [/\byearly\b/i, "annual"],
  [/\bquarterly\b/i, "quarterly"],
  [/\bmonthly\b/i, "monthly"],
  [/\bbi[-\s]?weekly\b/i, "bi-weekly"],
  [/\bweekly\b/i, "weekly"],
  [/\b(\d+)[-\s]?year\b/i, (m) => `${m[1]}-year`],
  [/\bevery\s+(\d+)\s+(year|month|week|day)s?\b/i, (m) => `every ${m[1]} ${m[2]}${m[1] === "1" ? "" : "s"}`],
  [/\bevery\s+(year|month|week)\b/i, (m) => `every ${m[1]}`],
];

function extractRecurrence(description) {
  if (!description) return null;
  for (const [re, out] of RECURRENCE_PATTERNS) {
    const m = description.match(re);
    if (m) return typeof out === "function" ? out(m) : out;
  }
  return null;
}

(async () => {
  const { rows } = await db.query(
    `SELECT DISTINCT sl.name AS line, s.description
       FROM appointment_services s
       LEFT JOIN service_lines sl ON sl.id = s.service_line_id
      WHERE s.description IS NOT NULL AND s.description <> ''`);

  const hits = [];
  for (const r of rows) {
    const rec = extractRecurrence(r.description);
    if (rec) hits.push({ line: r.line, rec, desc: r.description.replace(/\s+/g, " ").slice(0, 70) });
  }
  console.log(`descriptions: ${rows.length} | with a recurrence: ${hits.length} (${Math.round(100 * hits.length / rows.length)}%)`);
  const byRec = {};
  for (const h of hits) byRec[h.rec] = (byRec[h.rec] || 0) + 1;
  console.log("cadences found:", byRec);
  console.log("\nsample matches:");
  for (const h of hits.slice(0, 12)) console.log(`  ${h.rec.padEnd(12)} [${h.line}] ${h.desc}`);

  // The sample job used for the comment drafts.
  const { rows: job } = await db.query(
    `SELECT sl.name AS line, s.description, a.scheduled_start
       FROM appointment_services s
       JOIN appointments a ON a.id = s.appointment_id
       LEFT JOIN service_lines sl ON sl.id = s.service_line_id
      WHERE a.job_id = 33186 ORDER BY a.scheduled_start`);
  console.log("\njob 33186:");
  for (const r of job) {
    console.log(`  ${r.scheduled_start.toISOString().slice(0, 10)} ${r.line} → recurrence: ${extractRecurrence(r.description) || "(none)"}`);
  }
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
