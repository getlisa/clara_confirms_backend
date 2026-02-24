/**
 * Per-company ServiceTrade: store auth_code (session token) only. Passwords are never stored.
 */

const db = require("./index");

/**
 * Get stored auth code for a company (only active, not deleted, with non-empty auth_code)
 * @param {string|number} companyId
 * @returns {Promise<{ username: string, authCode: string }|null>}
 */
async function getByCompanyId(companyId) {
  const result = await db.query(
    `SELECT username, auth_code FROM company_servicetrade
     WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE
       AND auth_code IS NOT NULL AND auth_code != ''`,
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { username: row.username, authCode: row.auth_code };
}

/**
 * Save or update ServiceTrade: username + auth_code (session token). On reconnect, merges optional metadata.
 * Password is never stored.
 * @param {string|number} companyId
 * @param {string} username
 * @param {string} authCode - ServiceTrade auth token (PHPSESSID value)
 * @param {object} [metadata] - optional; merged into existing metadata on update
 */
async function upsert(companyId, username, authCode, metadata = null) {
  if (metadata != null && typeof metadata === "object") {
    await db.query(
      `INSERT INTO company_servicetrade (company_id, username, auth_code, updated_at, is_active, is_deleted, metadata)
       VALUES ($1, $2, $3, NOW(), TRUE, FALSE, COALESCE($4::jsonb, '{}'::jsonb))
       ON CONFLICT (company_id) DO UPDATE SET
         username = EXCLUDED.username,
         auth_code = EXCLUDED.auth_code,
         updated_at = NOW(),
         is_active = TRUE,
         is_deleted = FALSE,
         metadata = COALESCE(company_servicetrade.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)`,
      [companyId, username, authCode, JSON.stringify(metadata)]
    );
  } else {
    await db.query(
      `INSERT INTO company_servicetrade (company_id, username, auth_code, updated_at, is_active, is_deleted)
       VALUES ($1, $2, $3, NOW(), TRUE, FALSE)
       ON CONFLICT (company_id) DO UPDATE SET
         username = EXCLUDED.username,
         auth_code = EXCLUDED.auth_code,
         updated_at = NOW(),
         is_active = TRUE,
         is_deleted = FALSE`,
      [companyId, username, authCode]
    );
  }
}

/**
 * Clear username and auth_code on disconnect; preserve metadata.
 * @param {string|number} companyId
 */
async function clearCredentials(companyId) {
  await db.query(
    `UPDATE company_servicetrade
     SET username = '', auth_code = NULL, is_active = FALSE, updated_at = NOW()
     WHERE company_id = $1`,
    [companyId]
  );
}

/**
 * Check if company has stored auth (active, not deleted, non-empty auth_code)
 * @param {string|number} companyId
 * @returns {Promise<boolean>}
 */
async function hasCredentials(companyId) {
  const result = await db.query(
    `SELECT 1 FROM company_servicetrade
     WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE
       AND auth_code IS NOT NULL AND auth_code != ''`,
    [companyId]
  );
  return result.rowCount > 0;
}

module.exports = {
  getByCompanyId,
  upsert,
  clearCredentials,
  hasCredentials,
};
