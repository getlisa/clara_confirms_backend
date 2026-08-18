/**
 * Who gets the daily report, and when — see migrations/096.
 */

const db = require("./index");

const REPORT_TYPES = { DAILY_OPERATIONS: "daily_operations" };

function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

/** DATE columns come back from pg as a JS Date at UTC midnight — normalize to
 * the 'YYYY-MM-DD' string the schedule resolver compares against. */
function toDateString(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

function present(row) {
  if (!row) return null;
  return {
    id: row.id,
    company_id: row.company_id,
    email: row.email,
    name: row.name,
    user_id: row.user_id,
    report_type: row.report_type,
    send_at_local: String(row.send_at_local).slice(0, 5), // 'HH:MM:SS' -> 'HH:MM'
    enabled: row.enabled,
    last_sent_for_date: toDateString(row.last_sent_for_date),
    last_sent_at: row.last_sent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function list(companyId, { reportType = null } = {}) {
  const params = [companyId];
  let filter = "";
  if (reportType) { params.push(reportType); filter = ` AND report_type = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT * FROM report_recipients WHERE company_id = $1${filter} ORDER BY created_at`,
    params
  );
  return rows.map(present);
}

async function getById(companyId, id) {
  const { rows } = await db.query(
    `SELECT * FROM report_recipients WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return present(rows[0]);
}

/** Throws with `.code === "DUPLICATE"` on a repeat (company, type, email) — the
 * route layer turns that into a 409 rather than a 500. */
async function create({ companyId, email, name = null, userId = null, reportType = REPORT_TYPES.DAILY_OPERATIONS, sendAtLocal = "21:00", enabled = false }) {
  try {
    const { rows } = await db.query(
      `INSERT INTO report_recipients (company_id, email, name, user_id, report_type, send_at_local, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [companyId, normalizeEmail(email), name, userId, reportType, sendAtLocal, enabled]
    );
    return present(rows[0]);
  } catch (err) {
    if (err.code === "23505") { const e = new Error("A recipient with this email already exists for this report"); e.code = "DUPLICATE"; throw e; }
    throw err;
  }
}

async function update(companyId, id, fields) {
  const cols = { email: "email", name: "name", send_at_local: "send_at_local", enabled: "enabled" };
  const sets = []; const params = [companyId, id];
  for (const [key, column] of Object.entries(cols)) {
    if (!(key in fields)) continue;
    params.push(key === "email" ? normalizeEmail(fields[key]) : fields[key]);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return getById(companyId, id);
  sets.push(`updated_at = now()`);
  try {
    const { rows } = await db.query(
      `UPDATE report_recipients SET ${sets.join(", ")} WHERE company_id = $1 AND id = $2 RETURNING *`,
      params
    );
    return present(rows[0]);
  } catch (err) {
    if (err.code === "23505") { const e = new Error("A recipient with this email already exists for this report"); e.code = "DUPLICATE"; throw e; }
    throw err;
  }
}

async function remove(companyId, id) {
  const { rowCount } = await db.query(
    `DELETE FROM report_recipients WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return rowCount > 0;
}

/**
 * Every enabled recipient, across every company, for the sweep to evaluate.
 * Company timezone / business hours are joined in here so the sweep does not
 * need a second round-trip per row.
 */
async function listAllEnabledForSweep() {
  const { rows } = await db.query(
    `SELECT r.*, c.default_timezone, cs.business_hours_end, cs.include_weekends
       FROM report_recipients r
       JOIN companies c ON c.id = r.company_id
       LEFT JOIN call_settings cs ON cs.company_id = r.company_id
      WHERE r.enabled = true AND (c.is_active = true OR c.is_active IS NULL) AND c.is_deleted IS NOT TRUE`
  );
  return rows.map((r) => ({ ...present(r), default_timezone: r.default_timezone, business_hours_end: r.business_hours_end, include_weekends: r.include_weekends }));
}

/** Stamp the BUSINESS DATE a report covered — the sweep's idempotency guard. */
async function markSent(id, targetDate) {
  await db.query(
    `UPDATE report_recipients SET last_sent_for_date = $2, last_sent_at = now() WHERE id = $1`,
    [id, targetDate]
  );
}

module.exports = { REPORT_TYPES, list, getById, create, update, remove, listAllEnabledForSweep, markSent };
