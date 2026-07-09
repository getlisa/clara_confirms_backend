/**
 * Shared helpers for the make_call / schedule_call write tools.
 *
 * Maps a trigger_type to its target field (matching the manual-call service) and
 * builds a human-readable summary of who/what a call targets, for the
 * confirmation preview. All lookups are tenant-scoped and best-effort (a failed
 * lookup just yields a thinner preview — the manual-call service does the
 * authoritative validation when the call is actually placed).
 */

const db = require("../../../../db");

const TARGET_FIELD = {
  scheduled_unconfirmed: "appointment_id",
  technician_unconfirmed: "appointment_id",
  open_job_due_soon: "job_id",
  quotation_pending: "quotation_id",
};

function targetIdFor(triggerType, args) {
  const field = TARGET_FIELD[triggerType];
  if (field === "appointment_id") return args.appointment_id;
  if (field === "job_id") return args.job_id;
  if (field === "quotation_id") return args.quotation_id;
  return null;
}

async function summarizeTarget(companyId, triggerType, args) {
  const field = TARGET_FIELD[triggerType];
  const id = targetIdFor(triggerType, args);
  const base = { target_field: field, target_id: id ?? null };
  if (id == null) return base;

  try {
    if (field === "appointment_id") {
      const r = await db.query(
        `SELECT a.scheduled_start, j.title AS job_title, c.full_name AS customer, c.phone
         FROM appointments a
         JOIN jobs j ON j.id = a.job_id
         JOIN customers c ON c.id = j.customer_id
         WHERE a.id = $1 AND j.company_id = $2`,
        [id, companyId]
      );
      return { ...base, ...(r.rows[0] || {}) };
    }
    if (field === "job_id") {
      const r = await db.query(
        `SELECT j.title AS job_title, j.due_by, c.full_name AS customer, c.phone
         FROM jobs j
         JOIN customers c ON c.id = j.customer_id
         WHERE j.id = $1 AND j.company_id = $2`,
        [id, companyId]
      );
      return { ...base, ...(r.rows[0] || {}) };
    }
    if (field === "quotation_id") {
      const r = await db.query(
        `SELECT q.quote_number, c.full_name AS customer, c.phone
         FROM quotations q
         JOIN customers c ON c.id = q.customer_id
         WHERE q.id = $1 AND q.company_id = $2`,
        [id, companyId]
      );
      return { ...base, ...(r.rows[0] || {}) };
    }
  } catch {
    /* best-effort preview only */
  }
  return base;
}

async function companyTimezone(companyId) {
  try {
    const r = await db.query(`SELECT default_timezone FROM companies WHERE id = $1`, [companyId]);
    return r.rows[0]?.default_timezone || "America/New_York";
  } catch {
    return "America/New_York";
  }
}

module.exports = { TARGET_FIELD, targetIdFor, summarizeTarget, companyTimezone };
