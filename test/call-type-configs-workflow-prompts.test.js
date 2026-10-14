/**
 * db/call-type-configs.js's generateDefaultPrompts — workflow-aware default
 * voice prompts (Phase 5). Mirrors what the chat workflow module already
 * does for tools/registry.js's CAPABILITY_TOOLS gate and prompt.build()'s
 * SERVICE LINK section, but for the voice default-prompt template: when the
 * resolved workflow lacks service-link capability (InspectPoint), the
 * generated general_prompt must omit the SERVICE LINK section entirely and
 * carry no dangling reference to it, and cancellation-reason phrasing softens
 * when the workflow marks it optional.
 *
 * The SERVICE LINK section is opt-in: only capabilities.serviceLink === true
 * includes it. prompt-sync.js sets that from the CRM AND the company's
 * call_settings.service_link_enabled ("Email the service link after
 * confirmation"), via withServiceLinkSetting. Omitting `workflow` (fresh-company
 * seeding) therefore means no section — the setting defaults to off.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [] }) });

const { generateDefaultPrompts } = require("../src/db/call-type-configs");

const SERVICETRADE_WORKFLOW = {
  slug: "servicetrade",
  capabilities: { serviceLink: true, slotSuggestion: false, cancellationReason: "required" },
};
const INSPECTPOINT_WORKFLOW = {
  slug: "inspectpoint",
  capabilities: { serviceLink: false, slotSuggestion: true, cancellationReason: "optional" },
};

test("no workflow argument (fresh-company seeding) omits the SERVICE LINK section — the setting defaults to off", () => {
  const result = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc");
  assert.doesNotMatch(result.general_prompt, /SERVICE LINK/);
  assert.doesNotMatch(result.general_prompt, /resolve_service_link_contact|get_service_link/);
  assert.match(result.general_prompt, /thank them and wrap up/);
  assert.match(result.general_prompt, /Can I ask why you'd like to cancel/);
});

test("serviceLink:true (CRM supports it AND the company enabled it) includes the SERVICE LINK section", () => {
  const result = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc", SERVICETRADE_WORKFLOW);
  assert.match(result.general_prompt, /━━━ SERVICE LINK/);
  assert.match(result.general_prompt, /go to the SERVICE LINK section/);
  assert.match(result.general_prompt, /resolve_service_link_contact/);
});

test("ServiceTrade with the setting off produces the same prompt as no workflow, byte for byte", () => {
  const off = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc",
    { ...SERVICETRADE_WORKFLOW, capabilities: { ...SERVICETRADE_WORKFLOW.capabilities, serviceLink: false } });
  const seeded = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc");
  assert.deepEqual(off, seeded);
});

test("serviceLink:false (InspectPoint) omits the SERVICE LINK section entirely", () => {
  const result = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc", INSPECTPOINT_WORKFLOW);
  assert.doesNotMatch(result.general_prompt, /SERVICE LINK/);
});

test("serviceLink:false (InspectPoint) leaves no dangling CASE B reference to the omitted section", () => {
  const result = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc", INSPECTPOINT_WORKFLOW);
  assert.doesNotMatch(result.general_prompt, /go to the SERVICE LINK section/);
  assert.match(result.general_prompt, /thank them and wrap up/);
});

test("cancellationReason:optional (InspectPoint) softens the cancel-reason ask", () => {
  const result = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc", INSPECTPOINT_WORKFLOW);
  assert.doesNotMatch(result.general_prompt, /Can I ask why you'd like to cancel/);
  assert.match(result.general_prompt, /optional here/);
});

test("GENERAL RULES and the rest of the template still follow immediately after the (possibly-empty) SERVICE LINK slot", () => {
  const result = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc", INSPECTPOINT_WORKFLOW);
  assert.match(result.general_prompt, /GENERAL RULES/);
});

test("non-customer_confirmation call types are unaffected by a passed workflow", () => {
  const withWorkflow = generateDefaultPrompts("technician_confirmation", "Technician Confirmation", "desc", INSPECTPOINT_WORKFLOW);
  const withoutWorkflow = generateDefaultPrompts("technician_confirmation", "Technician Confirmation", "desc");
  assert.deepEqual(withWorkflow, withoutWorkflow);
});
