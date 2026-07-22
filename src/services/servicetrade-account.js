/**
 * Sync the ServiceTrade account's timezone into `companies.default_timezone`.
 *
 * All time-based calculations in this backend (office-hours gating, dispatch
 * windows, reschedule/create-appointment local↔UTC conversion, retry/callback
 * timing, trigger date-window matching) read `companies.default_timezone` —
 * one column, no separate resolver. So once this column holds the CRM's
 * timezone, every one of those call sites is correct with zero changes there.
 *
 * Confirmed via a real captured GET /account response:
 *   { data: { accounts: [ { id, name, timezone, primeCompany, features } ] } }
 *
 * Best-effort: never throws — a failed timezone sync must not break a
 * ServiceTrade connect or a scheduled CRM sync.
 */

const db = require("../db");
const { stLoggedRequest } = require("./servicetrade-api");
const logger = require("../utils/logger");

/**
 * @param {number|string} companyId
 * @returns {Promise<string|null>} the resolved IANA timezone, or null if none was found/set
 */
async function syncAccountTimezone(companyId) {
  try {
    const res = await stLoggedRequest(companyId, "GET", "/account", { context: "account.fetch" });
    if (!res.ok) {
      logger.warn("servicetrade account: fetch failed; leaving default_timezone unchanged", { companyId, status: res.status });
      return null;
    }
    const account = Array.isArray(res.data?.accounts) ? res.data.accounts[0] : null;
    const timezone = account?.timezone || null;
    if (!timezone) {
      logger.warn("servicetrade account: response had no usable timezone; leaving default_timezone unchanged", { companyId });
      return null;
    }

    await db.query(
      `UPDATE companies SET default_timezone = $1, updated_at = NOW() WHERE id = $2`,
      [timezone, companyId]
    );
    await db.query(
      `UPDATE servicetrade_integration
          SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
        WHERE company_id = $2`,
      [
        JSON.stringify({
          account_timezone: timezone,
          account_id: account?.id ?? null,
          account_name: account?.name ?? null,
          account_timezone_synced_at: new Date().toISOString(),
        }),
        companyId,
      ]
    );

    logger.info("servicetrade account: default_timezone synced from CRM", { companyId, timezone });
    return timezone;
  } catch (err) {
    logger.error("servicetrade account: sync failed", { companyId, error: err.message });
    return null;
  }
}

module.exports = { syncAccountTimezone };
