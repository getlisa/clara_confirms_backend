/**
 * Per-company ServiceTrade credentials (company_servicetrade table)
 */

const db = require("./index");

/**
 * Get credentials for a company
 * @param {string|number} companyId
 * @returns {Promise<{ username: string, password: string }|null>}
 */
async function getByCompanyId(companyId) {
  const result = await db.query(
    "SELECT username, password FROM company_servicetrade WHERE company_id = $1",
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { username: row.username, password: row.password };
}

/**
 * Save or update ServiceTrade credentials for a company
 * @param {string|number} companyId
 * @param {string} username
 * @param {string} password
 */
async function upsert(companyId, username, password) {
  await db.query(
    `INSERT INTO company_servicetrade (company_id, username, password, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (company_id) DO UPDATE SET
       username = EXCLUDED.username,
       password = EXCLUDED.password,
       updated_at = NOW()`,
    [companyId, username, password]
  );
}

/**
 * Check if company has ServiceTrade credentials stored
 * @param {string|number} companyId
 * @returns {Promise<boolean>}
 */
async function hasCredentials(companyId) {
  const result = await db.query(
    "SELECT 1 FROM company_servicetrade WHERE company_id = $1",
    [companyId]
  );
  return result.rowCount > 0;
}

module.exports = {
  getByCompanyId,
  upsert,
  hasCredentials,
};
