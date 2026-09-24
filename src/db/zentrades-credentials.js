/**
 * Per-company ZenTrades: username + encrypted password, plus a cached
 * session JWT. Same table conventions as its two siblings (is_active/
 * is_deleted, metadata merge-on-reconnect) but a genuinely different secret
 * shape — see migrations/107_zentrades_integration.sql's header for why a
 * password has to be stored at all here, unlike ServiceTrade (one global
 * service account, only a cookie stored) or InspectPoint (the API key IS
 * the long-lived credential).
 *
 * `getByCompanyId` never decrypts — it's the generic "is this integration
 * connected" read used by status/display code. `getCredentialsForLogin` is
 * the only function that calls crypto.decrypt, and it exists specifically
 * for services/zentrades.js's login() to consume.
 */

const db = require("./index");
const crypto = require("../utils/crypto");

/**
 * @param {string|number} companyId
 * @returns {Promise<{ username: string, hasPassword: boolean, accessToken: string|null,
 *   accessTokenExpiresAt: Date|null, authStatus: string, authFailedAt: Date|null,
 *   authError: string|null, metadata: object }|null>}
 */
async function getByCompanyId(companyId) {
  const result = await db.query(
    `SELECT username, auth_code, access_token, access_token_expires_at,
            auth_status, auth_failed_at, auth_error, metadata
       FROM zentrades_integration
      WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE
        AND auth_code IS NOT NULL AND auth_code != ''`,
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    username: row.username,
    hasPassword: true,
    accessToken: row.access_token,
    accessTokenExpiresAt: row.access_token_expires_at,
    authStatus: row.auth_status,
    authFailedAt: row.auth_failed_at,
    authError: row.auth_error,
    metadata: row.metadata || {},
  };
}

/**
 * The only function that decrypts the stored password — for
 * services/zentrades.js's login() only. Returns null (not a decrypt error)
 * for a company with no credentials row, so a caller can treat "not
 * connected" and "connected but currently locked out" the same way at this
 * layer; auth_status is what distinguishes them.
 *
 * @param {string|number} companyId
 * @returns {Promise<{ username: string, password: string }|null>}
 */
async function getCredentialsForLogin(companyId) {
  const result = await db.query(
    `SELECT username, auth_code FROM zentrades_integration
     WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE
       AND auth_code IS NOT NULL AND auth_code != ''`,
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { username: row.username, password: crypto.decrypt(row.auth_code) };
}

/**
 * Save or update ZenTrades credentials — always encrypts the password.
 * Resets auth_status to 'ok' and clears any prior failure, since a fresh
 * credential save is exactly the recovery path for both failure states.
 *
 * @param {string|number} companyId
 * @param {string} username
 * @param {string} password — plaintext; encrypted before storage
 * @param {object} [metadata]
 */
async function upsert(companyId, username, password, metadata = null) {
  const encrypted = crypto.encrypt(password);
  await db.query(
    `INSERT INTO zentrades_integration
       (company_id, username, auth_code, updated_at, is_active, is_deleted,
        auth_status, auth_failed_at, auth_error, metadata)
     VALUES ($1, $2, $3, NOW(), TRUE, FALSE, 'ok', NULL, NULL, COALESCE($4::jsonb, '{}'::jsonb))
     ON CONFLICT (company_id) DO UPDATE SET
       username = EXCLUDED.username,
       auth_code = EXCLUDED.auth_code,
       updated_at = NOW(),
       is_active = TRUE,
       is_deleted = FALSE,
       auth_status = 'ok',
       auth_failed_at = NULL,
       auth_error = NULL,
       access_token = NULL,
       access_token_expires_at = NULL,
       metadata = COALESCE(zentrades_integration.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)`,
    [companyId, username, encrypted, metadata ? JSON.stringify(metadata) : null]
  );
}

/**
 * Cache a freshly-minted access token. Called after every successful login
 * so subsequent requests (this run or a later one) can skip the login call
 * entirely until close to expiry.
 *
 * @param {string|number} companyId
 * @param {string} accessToken
 * @param {Date|string} expiresAt
 */
async function setAccessToken(companyId, accessToken, expiresAt) {
  await db.query(
    `UPDATE zentrades_integration
        SET access_token = $2, access_token_expires_at = $3, updated_at = NOW()
      WHERE company_id = $1`,
    [companyId, accessToken, expiresAt]
  );
}

/**
 * Record a login failure. Deliberately does NOT touch auth_code/username —
 * see migrations/107's header: clearing the password would make
 * resolveSlugForCompany() fall back to "servicetrade" for this company.
 * Only auth_status (+ the access token, now useless) changes.
 *
 * @param {string|number} companyId
 * @param {'invalid_credentials'|'forbidden'} status
 * @param {string} [error]
 */
async function markAuthFailed(companyId, status, error = null) {
  await db.query(
    `UPDATE zentrades_integration
        SET auth_status = $2, auth_failed_at = NOW(), auth_error = $3,
            access_token = NULL, access_token_expires_at = NULL, updated_at = NOW()
      WHERE company_id = $1`,
    [companyId, status, error ? String(error).slice(0, 2000) : null]
  );
}

/**
 * Clear the stored password on explicit disconnect; username + metadata are
 * preserved for a one-click reconnect, matching InspectPoint's convention.
 * @param {string|number} companyId
 */
async function clearCredentials(companyId) {
  await db.query(
    `UPDATE zentrades_integration
     SET auth_code = NULL, access_token = NULL, access_token_expires_at = NULL,
         is_active = FALSE, updated_at = NOW()
     WHERE company_id = $1`,
    [companyId]
  );
}

/**
 * @param {string|number} companyId
 * @returns {Promise<boolean>}
 */
async function hasCredentials(companyId) {
  const result = await db.query(
    `SELECT 1 FROM zentrades_integration
     WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE
       AND auth_code IS NOT NULL AND auth_code != ''`,
    [companyId]
  );
  return result.rowCount > 0;
}

module.exports = {
  getByCompanyId,
  getCredentialsForLogin,
  upsert,
  setAccessToken,
  markAuthFailed,
  clearCredentials,
  hasCredentials,
};
