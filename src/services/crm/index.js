/**
 * CRM provider registry.
 *
 * Each external CRM (ServiceTrade, BuildOps, ServiceTitan, …) implements
 * the `CrmProvider` base class (in ./base.js) so the rest of the platform
 * can sync data and call APIs without knowing the concrete provider.
 *
 *   const provider = getProvider('servicetrade');
 *   await provider.syncAll(companyId);
 *
 * Adding a new CRM:
 *   1. Subclass CrmProvider in src/services/crm/<slug>/provider.js
 *   2. Export a singleton instance from that file
 *   3. Add a `registerProvider(require(...))` line below
 */

const { CrmProvider } = require("./base");
const db = require("../../db");
const logger = require("../../utils/logger");

const providers = new Map();

function registerProvider(instance) {
  if (!(instance instanceof CrmProvider)) {
    throw new Error("registerProvider: argument must be a CrmProvider instance");
  }
  providers.set(instance.slug, instance);
}

function getProvider(slug) {
  const p = providers.get(slug);
  if (!p) throw new Error(`Unknown CRM provider: ${slug}`);
  return p;
}

function listProviders() {
  return Array.from(providers.keys());
}

// Matches routes/admin.js's own <slug>_integration convention — validated
// before being interpolated into a table name, since a slug ultimately
// comes from a provider's own `get slug()` string, not user input, but this
// function is a genuine SQL-identifier boundary and should never trust that
// blindly.
const SLUG_TABLE_PATTERN = /^[a-z_]+$/;

/**
 * Which CRM a company actually uses, resolved by checking each registered
 * provider's own `<slug>_integration` table for an active credential row —
 * the same naming convention routes/admin.js's cron resolver already
 * documents ("future CRMs will follow the `<slug>_integration` convention.
 * Generalize when we add another."). No `crm_provider` column exists (or is
 * added by this) — this IS the generalization, done without one.
 *
 * Defaults to "servicetrade" — today's only real CRM — when nothing
 * matches. Never throws: this feeds a live chat turn, and a CRM whose
 * integration table doesn't exist yet (or errors for any other reason) must
 * degrade to the default rather than break the conversation for every
 * company.
 */
async function resolveSlugForCompany(companyId) {
  for (const slug of listProviders()) {
    if (!SLUG_TABLE_PATTERN.test(slug)) continue;
    const table = `${slug}_integration`;
    try {
      const { rows } = await db.query(
        `SELECT 1 FROM ${table} WHERE company_id = $1 AND is_active = true AND auth_code IS NOT NULL AND auth_code <> '' LIMIT 1`,
        [companyId]
      );
      if (rows.length) return slug;
    } catch (err) {
      logger.warn("crm: resolveSlugForCompany check failed — skipping this provider", { slug, companyId, error: err.message });
    }
  }
  return "servicetrade";
}

// Eagerly register built-in providers.
// Each subclass file should export a singleton instance.
registerProvider(require("./servicetrade/provider"));

module.exports = { CrmProvider, registerProvider, getProvider, listProviders, resolveSlugForCompany };
