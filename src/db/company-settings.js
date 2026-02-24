/**
 * Company settings (company_settings table): max_users and future config
 */

const db = require("./index");

const DEFAULT_MAX_USERS = 3;

/**
 * Get max_users for a company. If no row exists, returns default (3).
 * @param {string|number} companyId
 * @returns {Promise<number>}
 */
async function getMaxUsers(companyId) {
  const result = await db.query(
    `SELECT max_users FROM company_settings
     WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE`,
    [companyId]
  );
  const row = result.rows[0];
  return row ? Number(row.max_users) : DEFAULT_MAX_USERS;
}

/**
 * Get full company_settings row for a company (or null)
 * @param {string|number} companyId
 * @returns {Promise<{ max_users: number, metadata: object }|null>}
 */
async function getByCompanyId(companyId) {
  const result = await db.query(
    `SELECT max_users, metadata FROM company_settings
     WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE`,
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    max_users: Number(row.max_users),
    metadata: row.metadata || {},
  };
}

/**
 * Ensure a company has a settings row (e.g. after company creation). Uses defaults if not present.
 * @param {string|number} companyId
 * @param {number} [maxUsers]
 */
async function upsert(companyId, maxUsers = DEFAULT_MAX_USERS) {
  await db.query(
    `INSERT INTO company_settings (company_id, max_users, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (company_id) DO UPDATE SET
       max_users = COALESCE(EXCLUDED.max_users, company_settings.max_users),
       updated_at = NOW()`,
    [companyId, maxUsers]
  );
}

module.exports = {
  getMaxUsers,
  getByCompanyId,
  upsert,
  DEFAULT_MAX_USERS,
};
