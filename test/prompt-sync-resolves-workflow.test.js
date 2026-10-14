/**
 * services/prompt-sync.js's resetDefaultPrompts — the one entry point that
 * genuinely needs the resolved workflow (Phase 5): it's the "reset to
 * default" path, so it's exactly when a company that switched CRMs should
 * get that CRM's shaped default prompt back, instead of a stale
 * ServiceTrade-flavored one baked in at company creation. Every other
 * generateDefaultPrompts call site (fresh company seeding, ad-hoc custom
 * type creation) intentionally still omits the workflow argument — a brand
 * new company has no CRM connected yet, so there's nothing to resolve.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const queries = [];
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } });
stub("services/retell", {});
stub("services/retell-flow", { syncFlowForCompany: async () => {} });
stub("db/service-line-descriptions", { listByCompany: async () => [] });

let resolvedCompanyId = null;
stub("services/crm", {
  resolveSlugForCompany: async (companyId) => {
    resolvedCompanyId = companyId;
    return "inspectpoint";
  },
});

let serviceLinkEnabled = true;
stub("db/call-settings", { getByCompanyId: async () => ({ service_link_enabled: serviceLinkEnabled }) });

let workflowPassedToGetWorkflow = null;
let crmSupportsServiceLink = false;
const { withServiceLinkSetting } = require("../src/confirmation-agent/workflows");
stub("confirmation-agent/workflows", {
  withServiceLinkSetting,
  getWorkflow: (slug) => {
    workflowPassedToGetWorkflow = slug;
    return { slug, capabilities: { serviceLink: crmSupportsServiceLink, slotSuggestion: true, cancellationReason: "optional" } };
  },
});

let capturedWorkflowArg = "not called";
const realCallTypeConfigs = require("../src/db/call-type-configs");
stub("db/call-type-configs", {
  BUILTIN_SEEDS: [{ type: "customer_confirmation", name: "Customer Confirmation", description: "desc" }],
  generateDefaultPrompts: (type, name, description, workflow) => {
    capturedWorkflowArg = workflow;
    return realCallTypeConfigs.generateDefaultPrompts(type, name, description, workflow);
  },
});

const { resetDefaultPrompts } = require("../src/services/prompt-sync");

test("resetDefaultPrompts resolves the company's own CRM workflow and passes it to generateDefaultPrompts", async () => {
  await resetDefaultPrompts(4242);
  assert.equal(resolvedCompanyId, 4242);
  assert.equal(workflowPassedToGetWorkflow, "inspectpoint");
  assert.equal(capturedWorkflowArg?.slug, "inspectpoint");
  assert.equal(capturedWorkflowArg?.capabilities?.serviceLink, false);
});

test("the UPDATE actually written carries the workflow-shaped prompt (no SERVICE LINK section for InspectPoint)", async () => {
  queries.length = 0;
  await resetDefaultPrompts(4242);
  const update = queries.find((q) => /UPDATE call_type_configs/.test(q.sql));
  assert.ok(update, "expected an UPDATE call_type_configs query");
  const [, generalPrompt] = update.params;
  assert.doesNotMatch(generalPrompt, /SERVICE LINK/);
});

// ── the company's "Email the service link after confirmation" setting ──────

async function writtenPrompt() {
  queries.length = 0;
  await resetDefaultPrompts(4242);
  return queries.find((q) => /UPDATE call_type_configs/.test(q.sql)).params[1];
}

test("CRM supports the service link AND the setting is on → SERVICE LINK section is written", async () => {
  crmSupportsServiceLink = true; serviceLinkEnabled = true;
  assert.match(await writtenPrompt(), /━━━ SERVICE LINK/);
});

test("CRM supports the service link but the setting is off → no SERVICE LINK section", async () => {
  crmSupportsServiceLink = true; serviceLinkEnabled = false;
  const p = await writtenPrompt();
  assert.doesNotMatch(p, /SERVICE LINK/);
  assert.doesNotMatch(p, /resolve_service_link_contact/);
});

test("setting on but the CRM has no service link (InspectPoint) → still no SERVICE LINK section", async () => {
  crmSupportsServiceLink = false; serviceLinkEnabled = true;
  assert.doesNotMatch(await writtenPrompt(), /SERVICE LINK/);
});
