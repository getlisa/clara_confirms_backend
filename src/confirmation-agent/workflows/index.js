/**
 * Confirmation-chat workflow registry — the conversational counterpart to
 * services/crm/index.js's provider registry, and deliberately shaped the
 * same way (slug -> Map, register()/get...()).
 *
 * CrmProvider (services/crm/base.js) only covers sync/normalize/API access
 * — nothing about how a CONVERSATION with a customer should go. That's what
 * a workflow module owns: capability flags (what does this CRM's chat
 * surface even support) and the must-hit checklist for its confirmation
 * flow. See workflows/servicetrade.js for the only implementation today.
 *
 * Adding a new CRM's chat workflow:
 *   1. Create workflows/<slug>.js exporting { slug, capabilities, checklist }
 *   2. Add a `register(require(...))` line below
 */

const servicetrade = require("./servicetrade");
const inspectpoint = require("./inspectpoint");

const workflows = new Map();

function register(workflow) {
  workflows.set(workflow.slug, workflow);
}

/**
 * Falls back to ServiceTrade for an unrecognised slug rather than throwing —
 * an unknown/misconfigured CRM must never break a live customer
 * conversation. This mirrors services/crm/index.js's getProvider() in
 * spirit but not behavior: that registry throws on purpose (a sync job
 * failing loudly is fine), a live chat turn failing is not.
 */
function getWorkflow(slug) {
  return workflows.get(slug) || workflows.get(servicetrade.slug);
}

register(servicetrade);
register(inspectpoint);

module.exports = { register, getWorkflow };
