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

// Eagerly register built-in providers.
// Each subclass file should export a singleton instance.
registerProvider(require("./servicetrade/provider"));

module.exports = { CrmProvider, registerProvider, getProvider, listProviders };
