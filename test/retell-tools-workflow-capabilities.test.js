/**
 * services/retell-tools.js's applyWorkflowCapabilities — the voice-side
 * equivalent of chat's tools/registry.js CAPABILITY_TOOLS gate (Phase 5).
 * Voice tools are registered with Retell once per settings change, not
 * rebuilt per turn like chat's, so the gate lives here instead: it computes
 * an "effective" call_settings object where a capability-less CRM overrides
 * the manual DB flag, and registerToolsForCompany's existing
 * `gated_by_setting` filter does the rest unchanged.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

// retell-tools.js transitively requires db/index.js (a real Pool at module
// load), plus services/crm (which eagerly registers both CRM providers) —
// stub everything on that path so requiring the module under test never
// opens a real connection, even though this file only exercises one pure
// function from it.
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [] }) });
stub("db/call-settings", { getByCompanyId: async () => ({}) });
stub("db/tool-definitions", { getAll: async () => [] });
stub("db/todos", { create: async () => {}, TODO_TYPES: { CRM_SYNC: "crm_sync" } });
stub("db/servicetrade-credentials", { getByCompanyId: async () => null });
stub("db/servicetrade-sync", {});
stub("db/technicians", {});
stub("db/inspectpoint-credentials", { getByCompanyId: async () => null });
stub("services/servicetrade", {});
stub("services/servicetrade-sync", { runSync: async () => ({ success: true }) });
stub("services/inspectpoint-sync", { runSync: async () => ({ success: true, counts: {} }) });
stub("services/job-confirmation-inference", { inferJobConfirmations: async () => {} });
stub("services/job-confirmation-status", { syncAllJobStatuses: async () => {} });
stub("services/retell", {});

const { applyWorkflowCapabilities } = require("../src/services/retell-tools");

test("service_link_enabled=true is preserved when the workflow supports service link (ServiceTrade)", () => {
  const result = applyWorkflowCapabilities({ service_link_enabled: true }, { capabilities: { serviceLink: true } });
  assert.equal(result.service_link_enabled, true);
});

test("service_link_enabled=true is overridden to false when the workflow has no service-link capability (InspectPoint)", () => {
  const result = applyWorkflowCapabilities({ service_link_enabled: true }, { capabilities: { serviceLink: false } });
  assert.equal(result.service_link_enabled, false);
});

test("service_link_enabled=false stays false regardless of the workflow's capability", () => {
  const result = applyWorkflowCapabilities({ service_link_enabled: false }, { capabilities: { serviceLink: true } });
  assert.equal(result.service_link_enabled, false);
});

test("a workflow with no capabilities object at all defaults to NOT withholding (undefined !== false)", () => {
  const result = applyWorkflowCapabilities({ service_link_enabled: true }, {});
  assert.equal(result.service_link_enabled, true);
});

test("every other settings field passes through untouched", () => {
  const result = applyWorkflowCapabilities({ service_link_enabled: true, agent_can_make_changes: false, crm_comment_writeback_enabled: true }, { capabilities: { serviceLink: false } });
  assert.equal(result.agent_can_make_changes, false);
  assert.equal(result.crm_comment_writeback_enabled, true);
});

test("slot_suggestion_enabled is computed fresh from the workflow — true only when slotSuggestion is exactly true (InspectPoint)", () => {
  const result = applyWorkflowCapabilities({}, { capabilities: { slotSuggestion: true } });
  assert.equal(result.slot_suggestion_enabled, true);
});

test("slot_suggestion_enabled is false when slotSuggestion is explicitly false (ServiceTrade)", () => {
  const result = applyWorkflowCapabilities({}, { capabilities: { slotSuggestion: false } });
  assert.equal(result.slot_suggestion_enabled, false);
});

test("slot_suggestion_enabled is false when the workflow declares no capabilities at all, regardless of any settings column", () => {
  const result = applyWorkflowCapabilities({ slot_suggestion_enabled: true }, {});
  assert.equal(result.slot_suggestion_enabled, false);
});
