const db = require("./index");

const DEFAULTS = {
  business_hours_start: "09:00",
  business_hours_end:   "17:00",
  max_attempts:         3,
  voicemail_behavior:   "leave",
  include_weekends:     false,
};

async function getByCompanyId(companyId) {
  const result = await db.query(
    `SELECT business_hours_start, business_hours_end, max_attempts,
            voicemail_behavior, include_weekends
     FROM call_settings WHERE company_id = $1`,
    [companyId]
  );
  return result.rows[0] ?? { ...DEFAULTS };
}

async function upsert(companyId, fields) {
  const allowed = ["business_hours_start", "business_hours_end", "max_attempts", "voicemail_behavior", "include_weekends"];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return getByCompanyId(companyId);
  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const values = [companyId, ...keys.map((k) => fields[k])];
  const result = await db.query(
    `INSERT INTO call_settings (company_id, ${keys.join(", ")})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(", ")})
     ON CONFLICT (company_id) DO UPDATE SET ${setClauses}, updated_at = NOW()
     RETURNING business_hours_start, business_hours_end, max_attempts, voicemail_behavior, include_weekends`,
    values
  );
  return result.rows[0];
}

module.exports = { getByCompanyId, upsert, DEFAULTS };
