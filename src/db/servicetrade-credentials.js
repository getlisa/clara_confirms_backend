/**
 * Per-company ServiceTrade connection: username, auth_code (the PHPSESSID
 * session), and the password ENCRYPTED (password_encrypted, AES-256-GCM via
 * utils/credential-crypto.js) so the backend can log in again by itself when
 * ServiceTrade ends a session — see services/servicetrade.js's reauthenticate.
 *
 * The password is never returned by getByCompanyId; only getPasswordForReauth
 * decrypts it, and only the re-login path calls that. Never log it.
 */

const db = require("./index");
const credentialCrypto = require("../utils/credential-crypto");
const logger = require("../utils/logger");

/**
 * Get stored auth code for a company (only active, not deleted, with non-empty auth_code)
 * @param {string|number} companyId
 * @returns {Promise<{ username: string, authCode: string }|null>}
 */
async function getByCompanyId(companyId) {
  const result = await db.query(
    `SELECT username, auth_code FROM servicetrade_integration
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
      `INSERT INTO servicetrade_integration (company_id, username, auth_code, updated_at, is_active, is_deleted, metadata)
       VALUES ($1, $2, $3, NOW(), TRUE, FALSE, COALESCE($4::jsonb, '{}'::jsonb))
       ON CONFLICT (company_id) DO UPDATE SET
         username = EXCLUDED.username,
         auth_code = EXCLUDED.auth_code,
         updated_at = NOW(),
         is_active = TRUE,
         is_deleted = FALSE,
         metadata = COALESCE(servicetrade_integration.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)`,
      [companyId, username, authCode, JSON.stringify(metadata)]
    );
  } else {
    await db.query(
      `INSERT INTO servicetrade_integration (company_id, username, auth_code, updated_at, is_active, is_deleted)
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
 * Persist the encrypted password + mark a fresh login. Called right after a
 * successful interactive connect. Returns whether the password was stored —
 * false means automatic renewal is off for this company.
 */
async function savePassword(companyId, password) {
  if (!password) return false;
  let encrypted;
  try {
    encrypted = credentialCrypto.encrypt(password);
  } catch (err) {
    logger.error("ServiceTrade: password NOT stored — sessions cannot be renewed automatically", { companyId, error: err.message });
    return false;
  }
  await db.query(
    `UPDATE servicetrade_integration
        SET password_encrypted = $2, last_login_at = NOW(), auth_error = NULL, auth_error_at = NULL
      WHERE company_id = $1`,
    [companyId, encrypted]
  );
  return true;
}

/**
 * Username + decrypted password for an automatic re-login, or null when the
 * company has none stored (connected before auto-renewal existed) or it
 * cannot be decrypted.
 */
async function getPasswordForReauth(companyId) {
  const { rows } = await db.query(
    `SELECT username, password_encrypted FROM servicetrade_integration
      WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE
        AND password_encrypted IS NOT NULL AND username IS NOT NULL AND username != ''`,
    [companyId]
  );
  if (!rows[0]) return null;
  try {
    return { username: rows[0].username, password: credentialCrypto.decrypt(rows[0].password_encrypted) };
  } catch (err) {
    logger.error("ServiceTrade: stored password could not be decrypted", { companyId, error: err.message });
    return null;
  }
}

/** Store the session from an automatic re-login and clear any auth error. */
async function updateSession(companyId, authCode) {
  await db.query(
    `UPDATE servicetrade_integration
        SET auth_code = $2, last_login_at = NOW(), auth_error = NULL, auth_error_at = NULL, updated_at = NOW()
      WHERE company_id = $1`,
    [companyId, authCode]
  );
}

/** Record that the session could not be renewed (the case a human must fix). */
async function markAuthError(companyId, message) {
  await db.query(
    `UPDATE servicetrade_integration
        SET auth_error = $2, auth_error_at = COALESCE(auth_error_at, NOW())
      WHERE company_id = $1`,
    [companyId, String(message || "Unknown error").slice(0, 500)]
  );
}

/** Connection health for the status endpoint. */
async function getAuthHealth(companyId) {
  const { rows } = await db.query(
    `SELECT password_encrypted IS NOT NULL AS auto_reconnect, last_login_at, auth_error, auth_error_at
       FROM servicetrade_integration WHERE company_id = $1`,
    [companyId]
  );
  return rows[0] || { auto_reconnect: false, last_login_at: null, auth_error: null, auth_error_at: null };
}

/** Every company with a live ServiceTrade connection — for the keep-alive cron. */
async function listActiveCompanyIds() {
  const { rows } = await db.query(
    `SELECT company_id FROM servicetrade_integration
      WHERE is_active = TRUE AND is_deleted = FALSE
        AND ((auth_code IS NOT NULL AND auth_code != '') OR password_encrypted IS NOT NULL)
      ORDER BY company_id`
  );
  return rows.map((r) => r.company_id);
}

/**
 * Clear username and auth_code on disconnect; preserve metadata.
 * @param {string|number} companyId
 */
async function clearCredentials(companyId) {
  await db.query(
    `UPDATE servicetrade_integration
     SET username = '', auth_code = NULL, password_encrypted = NULL, auth_error = NULL, auth_error_at = NULL,
         is_active = FALSE, updated_at = NOW()
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
    `SELECT 1 FROM servicetrade_integration
     WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE
       AND auth_code IS NOT NULL AND auth_code != ''`,
    [companyId]
  );
  return result.rowCount > 0;
}

module.exports = {
  getByCompanyId,
  upsert,
  savePassword,
  getPasswordForReauth,
  updateSession,
  markAuthError,
  getAuthHealth,
  listActiveCompanyIds,
  clearCredentials,
  hasCredentials,
};
