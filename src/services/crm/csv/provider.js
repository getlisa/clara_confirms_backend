/**
 * CsvProvider — the "no CRM at all" provider.
 *
 * This exists almost entirely so a CRM-less company stops being treated as a
 * ServiceTrade company. `resolveSlugForCompany` (services/crm/index.js) probes
 * each `<slug>_integration` table and **defaults to "servicetrade"** when
 * nothing matches, which means a company that uploads CSVs would otherwise
 * have its confirmation comments POSTed at a ServiceTrade account it doesn't
 * have, and would get the ServiceTrade chat workflow (which offers a service
 * link that cannot exist).
 *
 * Registering a real provider fixes both at once, and costs almost nothing:
 *   - every write-back mirror inherits CrmProvider's `{skipped:"not_supported"}`
 *     default (base.js), which is exactly right — there is no CRM to write
 *     back to, so a confirm/reschedule/cancel correctly stops at our tables
 *   - `getProviderForSource("csv")` resolves instead of returning null
 *   - `getWorkflow("csv")` finds workflows/csv.js instead of falling back
 *
 * There is no client, no credentials and no API. Data arrives by upload —
 * see engines/csv-import and services/csv-import/.
 */

const { CrmProvider } = require("../base");

const SOURCE = "csv";

class CsvProvider extends CrmProvider {
  get slug() { return SOURCE; }

  get supportedEntities() {
    return ["customers", "contacts", "locations", "jobs", "appointments"];
  }

  /**
   * There is nothing to authenticate against — the sentinel `auth_code='csv'`
   * on the integration row exists only to satisfy the discovery predicate
   * shared by resolveSlugForCompany and the crm-sync cron.
   */
  async getCredentials(_companyId) {
    return null;
  }

  /**
   * No-ops, NOT inherited.
   *
   * `/admin/crm-sync` runs every 2 hours and, for each registered provider,
   * selects companies from `<slug>_integration WHERE is_active AND auth_code
   * <> ''` and calls `provider.syncAll(companyId)` (routes/admin.js). The
   * sentinel auth_code that makes resolveSlugForCompany work therefore also
   * puts every CSV company into that loop — and the base class's syncAll
   * THROWS. Left inherited, this logs an error per CSV company every 2 hours
   * forever.
   *
   * Returning an explicit skip is also more honest than silence: a CSV company
   * genuinely has nothing to pull, because data only ever arrives by upload.
   */
  async syncAll(_companyId) {
    return { ok: true, skipped: "csv_has_no_remote_to_sync", counts: {} };
  }

  async syncEntity(_companyId, _entityType) {
    return { ok: true, skipped: "csv_has_no_remote_to_sync", count: 0 };
  }

  /** No API to call. Throwing here would be a bug in the caller, not a runtime condition. */
  async request(_companyId, _method, _path, _opts) {
    throw new Error("csv: there is no CSV API to call — data arrives by upload");
  }
}

module.exports = new CsvProvider();
