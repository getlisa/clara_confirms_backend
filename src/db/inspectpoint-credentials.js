/**
 * Per-company InspectPoint: subdomain + auth_code (the API key). Mirrors
 * db/servicetrade-credentials.js's shape exactly — same table conventions
 * (is_active/is_deleted, metadata merge-on-reconnect) — but there is no
 * password or session concept here: the API key IS the long-lived credential,
 * not a token minted from one.
 */

const db = require("./index");

/**
 * @param {string|number} companyId
 * @returns {Promise<{ subdomain: string, authCode: string }|null>}
 */
async function getByCompanyId(companyId) {
  const result = await db.query(
    `SELECT subdomain, auth_code FROM inspectpoint_integration
     WHERE company_id = $1 AND is_active = TRUE AND is_deleted = FALSE
       AND auth_code IS NOT NULL AND auth_code != ''`,
    [companyId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { subdomain: row.subdomain, authCode: row.auth_code };
}

/**
 * Save or update InspectPoint credentials. On reconnect, metadata is merged
 * into what's already stored.
 * @param {string|number} companyId
 * @param {string} subdomain
 * @param {string} authCode - the InspectPoint API key
 * @param {object} [metadata]
 */
async function upsert(companyId, subdomain, authCode, metadata = null) {
  if (metadata != null && typeof metadata === "object") {
    await db.query(
      `INSERT INTO inspectpoint_integration (company_id, subdomain, auth_code, updated_at, is_active, is_deleted, metadata)
       VALUES ($1, $2, $3, NOW(), TRUE, FALSE, COALESCE($4::jsonb, '{}'::jsonb))
       ON CONFLICT (company_id) DO UPDATE SET
         subdomain = EXCLUDED.subdomain,
         auth_code = EXCLUDED.auth_code,
         updated_at = NOW(),
         is_active = TRUE,
         is_deleted = FALSE,
         metadata = COALESCE(inspectpoint_integration.metadata, '{}'::jsonb) || COALESCE(EXCLUDED.metadata, '{}'::jsonb)`,
      [companyId, subdomain, authCode, JSON.stringify(metadata)]
    );
  } else {
    await db.query(
      `INSERT INTO inspectpoint_integration (company_id, subdomain, auth_code, updated_at, is_active, is_deleted)
       VALUES ($1, $2, $3, NOW(), TRUE, FALSE)
       ON CONFLICT (company_id) DO UPDATE SET
         subdomain = EXCLUDED.subdomain,
         auth_code = EXCLUDED.auth_code,
         updated_at = NOW(),
         is_active = TRUE,
         is_deleted = FALSE`,
      [companyId, subdomain, authCode]
    );
  }
}

/**
 * Clear the API key on disconnect; preserve subdomain + metadata so a
 * reconnect only needs a new key.
 * @param {string|number} companyId
 */
async function clearCredentials(companyId) {
  await db.query(
    `UPDATE inspectpoint_integration
     SET auth_code = NULL, is_active = FALSE, updated_at = NOW()
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
    `SELECT 1 FROM inspectpoint_integration
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
