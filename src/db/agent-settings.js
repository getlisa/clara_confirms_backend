const db = require("./index");

const DEFAULTS = {
  representative_name: null,
  begin_message: null,
  general_prompt: null,
  days_before_confirmation: 2,
};

const ALLOWED_FIELDS = [
  "representative_name",
  "begin_message",
  "general_prompt",
  "days_before_confirmation",
];

function rowToObject(row) {
  return {
    representative_name: row.representative_name ?? null,
    begin_message: row.begin_message ?? null,
    general_prompt: row.general_prompt ?? null,
    days_before_confirmation: Number(row.days_before_confirmation),
  };
}

async function getByCompanyId(companyId) {
  const result = await db.query(
    `SELECT representative_name, begin_message, general_prompt, days_before_confirmation
     FROM agent_settings WHERE company_id = $1`,
    [companyId]
  );
  return result.rows[0] ? rowToObject(result.rows[0]) : { ...DEFAULTS };
}

async function upsert(companyId, fields) {
  const provided = ALLOWED_FIELDS.filter((k) => k in fields);
  if (provided.length === 0) return getByCompanyId(companyId);

  const values = [companyId, ...provided.map((k) => fields[k])];
  const insertCols = provided.join(", ");
  const insertPlaceholders = provided.map((_, i) => `$${i + 2}`).join(", ");
  const setClauses = provided.map((k, i) => `${k} = $${i + 2}`).join(", ");

  const result = await db.query(
    `INSERT INTO agent_settings (company_id, ${insertCols})
     VALUES ($1, ${insertPlaceholders})
     ON CONFLICT (company_id) DO UPDATE SET
       ${setClauses},
       updated_at = NOW()
     RETURNING representative_name, begin_message, general_prompt, days_before_confirmation`,
    values
  );
  return rowToObject(result.rows[0]);
}

module.exports = { getByCompanyId, upsert };
