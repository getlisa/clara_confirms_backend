/**
 * Pre-visit instructions the customer must act on before the technician
 * arrives, keyed by job type — see migrations/112 (CMAP-230).
 *
 * Deliberately separate from onsite_instructions (101, keyed by service_line,
 * about what happens ON SITE) and service_line_descriptions (084, soft-matched
 * narration). Nothing here reads or writes either of those — a distinction the
 * UI has to preserve too, so it is drawn for the frontend in
 * docs/previsit-instructions-frontend.md §1.
 */

const db = require("./index");

/**
 * Keys are matched exactly, so both sides of the comparison must be normalised
 * the same way. Mirrors how routes/call-settings.js normalises
 * confirmation_contact_types, and how the picker endpoint returns job types.
 */
function normalizeJobType(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  return v === "" ? null : v;
}

function present(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    company_id: row.company_id,
    job_type: row.job_type,
    // Falls back to the key so the UI always has something to render — a row
    // created before a label was supplied would otherwise show blank.
    job_type_label: row.job_type_label || row.job_type,
    instruction: row.instruction,
    requires_acknowledgement: row.requires_acknowledgement === true,
    sort_order: row.sort_order,
    active: row.active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Stable order for both the UI list and the spoken sequence. */
const ORDER = `ORDER BY job_type, sort_order, id`;

async function list(companyId, { jobType = null, activeOnly = false } = {}) {
  const params = [companyId];
  let filter = "";
  const key = normalizeJobType(jobType);
  if (key) { params.push(key); filter += ` AND job_type = $${params.length}`; }
  if (activeOnly) filter += ` AND active`;
  const { rows } = await db.query(
    `SELECT * FROM job_type_instructions WHERE company_id = $1${filter} ${ORDER}`,
    params
  );
  return rows.map(present);
}

async function getById(companyId, id) {
  const { rows } = await db.query(
    `SELECT * FROM job_type_instructions WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return present(rows[0]);
}

/**
 * What the agent actually reads: the active instructions for this job's type.
 *
 * Returns [] for a null/blank job_type rather than throwing — 32 of company
 * 14's jobs have no job_type at all, and a job with no type simply has no
 * pre-visit instructions. Never widen this to "match everything on null": a
 * typeless job would then inherit every instruction the company has written.
 */
async function listForJobType(companyId, jobType) {
  const key = normalizeJobType(jobType);
  if (!key) return [];
  const { rows } = await db.query(
    `SELECT * FROM job_type_instructions
      WHERE company_id = $1 AND job_type = $2 AND active
      ${ORDER}`,
    [companyId, key]
  );
  return rows.map(present);
}

const DUPLICATE_MESSAGE = "This instruction already exists for that job type";

function asDuplicate(err) {
  if (err.code !== "23505") return err;
  const e = new Error(DUPLICATE_MESSAGE);
  e.code = "DUPLICATE";
  return e;
}

/** Throws with `.code === "DUPLICATE"` on a repeat (company, job_type,
 * instruction) — the route turns that into a 409 rather than a 500. */
async function create({ companyId, jobType, instruction, requiresAcknowledgement = false, sortOrder = 0, active = true }) {
  const key = normalizeJobType(jobType);
  try {
    const { rows } = await db.query(
      `INSERT INTO job_type_instructions
         (company_id, job_type, job_type_label, instruction, requires_acknowledgement, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      // The label keeps the user's own capitalisation; the key is normalised.
      [companyId, key, String(jobType).trim(), String(instruction).trim(), requiresAcknowledgement === true, sortOrder, active !== false]
    );
    return present(rows[0]);
  } catch (err) {
    throw asDuplicate(err);
  }
}

async function update(companyId, id, fields) {
  const sets = [];
  const params = [companyId, id];
  const push = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };

  if ("job_type" in fields) {
    push("job_type", normalizeJobType(fields.job_type));
    push("job_type_label", String(fields.job_type).trim());
  }
  if ("instruction" in fields) push("instruction", String(fields.instruction).trim());
  if ("requires_acknowledgement" in fields) push("requires_acknowledgement", fields.requires_acknowledgement === true);
  if ("sort_order" in fields) push("sort_order", fields.sort_order);
  if ("active" in fields) push("active", fields.active === true);

  if (!sets.length) return getById(companyId, id);
  sets.push(`updated_at = now()`);
  try {
    const { rows } = await db.query(
      `UPDATE job_type_instructions SET ${sets.join(", ")} WHERE company_id = $1 AND id = $2 RETURNING *`,
      params
    );
    return present(rows[0]);
  } catch (err) {
    throw asDuplicate(err);
  }
}

async function remove(companyId, id) {
  const { rowCount } = await db.query(
    `DELETE FROM job_type_instructions WHERE company_id = $1 AND id = $2`,
    [companyId, id]
  );
  return rowCount > 0;
}

/**
 * Options for the job-type picker: every distinct job_type this company
 * actually has, with how many jobs carry it.
 *
 * Same shape and reasoning as GET /call-settings/contact-types — these are
 * CRM-supplied free text, not a fixed enum, and they differ completely between
 * providers (InspectPoint gives "Fire Suppression", ServiceTrade gives
 * "inspection"). Returned already normalised, so a value from here can be sent
 * straight back in a POST and will match at call time.
 */
async function listJobTypeOptions(companyId) {
  const { rows } = await db.query(
    `SELECT lower(btrim(job_type)) AS job_type,
            min(btrim(job_type)) AS label,
            count(*)::int AS job_count
       FROM jobs
      WHERE company_id = $1 AND job_type IS NOT NULL AND btrim(job_type) <> ''
      GROUP BY 1
      ORDER BY job_count DESC, job_type`,
    [companyId]
  );
  return rows;
}

module.exports = {
  list,
  getById,
  listForJobType,
  create,
  update,
  remove,
  listJobTypeOptions,
  normalizeJobType,
};
