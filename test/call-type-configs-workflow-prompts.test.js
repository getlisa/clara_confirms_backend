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
 * The SERVICE LINK section is never part of the generated (user-editable)
 * prompt, for any workflow: it is the managed SERVICE_LINK_SECTION block that
 * prompt-sync.js's composeRetellPrompt appends at push time, only while the
 * company has "Email the service link after confirmation" on. CASE B therefore
 * refers to it conditionally.
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

const MARKER = "━━━ SERVICE LINK";
const { SERVICE_LINK_SECTION, SERVICE_LINK_PROMPT_MARKER } = require("../src/db/call-type-configs");

test("the generated prompt never contains the SERVICE LINK section, whatever the workflow", () => {
  for (const wf of [undefined, SERVICETRADE_WORKFLOW, INSPECTPOINT_WORKFLOW]) {
    const { general_prompt } = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc", wf);
    assert.ok(!general_prompt.includes(MARKER), `section leaked for ${wf?.slug || "no workflow"}`);
    assert.doesNotMatch(general_prompt, /resolve_service_link_contact/);
  }
});

test("CASE B points at the SERVICE LINK section only if it is present, else wraps up", () => {
  const { general_prompt } = generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc", SERVICETRADE_WORKFLOW);
  assert.match(general_prompt, /If these instructions include a SERVICE LINK section, go to it now; otherwise wrap up/);
});

test("the managed SERVICE_LINK_SECTION block carries the full service-link flow and its marker", () => {
  assert.ok(SERVICE_LINK_SECTION.startsWith(SERVICE_LINK_PROMPT_MARKER));
  assert.match(SERVICE_LINK_SECTION, /resolve_service_link_contact/);
  assert.match(SERVICE_LINK_SECTION, /email_confirmed=true/);
  assert.match(SERVICE_LINK_SECTION, /Do NOT call get_service_link/);
});

test("ServiceTrade and no-workflow defaults are identical (only cancellation phrasing is workflow-shaped)", () => {
  assert.deepEqual(
    generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc", SERVICETRADE_WORKFLOW),
    generateDefaultPrompts("customer_confirmation", "Customer Confirmation", "desc"),
  );
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
