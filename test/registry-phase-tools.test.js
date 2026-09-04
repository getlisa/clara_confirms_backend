/**
 * tools/registry.js's PHASE_TOOLS — the structural gate on what the model
 * can call in each phase. Covers two additions from this pass:
 *   - decline_remaining_appointments is now ALSO reachable via ordinary
 *     phase gating (not just the card-trigger exclusiveTool override) — see
 *     graph/prompt.js's OTHER_APPOINTMENTS. Without this, a free-text-only
 *     conversation had no way to ever stamp remaining_addressed_at, and
 *     POST /:token/end would 409 forever.
 *   - capture_confirmer_identity is offered in every phase, including
 *     no_appointment, since identity should be captured before the FIRST
 *     mutating action of any kind (create_appointment included).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { getToolsForPhase } = require("../src/confirmation-agent/tools/registry");

function names(tools) {
  return tools.map((t) => t.name).sort();
}

test("decline_remaining_appointments is reachable via ordinary phase gating in confirming", () => {
  assert.ok(names(getToolsForPhase("confirming")).includes("decline_remaining_appointments"));
});

test("decline_remaining_appointments is reachable via ordinary phase gating in all_confirmed", () => {
  assert.ok(names(getToolsForPhase("all_confirmed")).includes("decline_remaining_appointments"));
});

test("decline_remaining_appointments does NOT apply to no_appointment — nothing booked yet to decline", () => {
  assert.ok(!names(getToolsForPhase("no_appointment")).includes("decline_remaining_appointments"));
});

test("capture_confirmer_identity is offered in every phase, including no_appointment", () => {
  assert.ok(names(getToolsForPhase("confirming")).includes("capture_confirmer_identity"));
  assert.ok(names(getToolsForPhase("all_confirmed")).includes("capture_confirmer_identity"));
  assert.ok(names(getToolsForPhase("no_appointment")).includes("capture_confirmer_identity"));
});

test("an exclusiveTool turn still binds ONLY that one tool, even though these two are now phase-gated too", () => {
  const tools = getToolsForPhase("confirming", { exclusiveTool: "decline_remaining_appointments" });
  assert.deepEqual(names(tools), ["decline_remaining_appointments"]);
});

test("the opening turn still withholds end_conversation/report_customer_intent, unaffected by this change", () => {
  const opening = names(getToolsForPhase("confirming", { isOpeningTurn: true }));
  assert.ok(!opening.includes("end_conversation"));
  assert.ok(!opening.includes("report_customer_intent"));
  assert.ok(opening.includes("capture_confirmer_identity"), "identity capture is still allowed on the opening turn");
});

// Phase 6: propose_reschedule_slots is phase-gated the same as
// reschedule_appointment (confirming/all_confirmed, never no_appointment —
// there's no existing appointment/technician to search yet), AND
// capability-gated by workflows/*.js's slotSuggestion flag.
test("propose_reschedule_slots is reachable in confirming and all_confirmed when no workflow is passed (capability defaults on)", () => {
  assert.ok(names(getToolsForPhase("confirming")).includes("propose_reschedule_slots"));
  assert.ok(names(getToolsForPhase("all_confirmed")).includes("propose_reschedule_slots"));
});

test("propose_reschedule_slots does NOT apply to no_appointment — nothing booked yet to reschedule", () => {
  assert.ok(!names(getToolsForPhase("no_appointment")).includes("propose_reschedule_slots"));
});

test("propose_reschedule_slots is withheld when the workflow's slotSuggestion capability is explicitly false (ServiceTrade)", () => {
  const tools = names(getToolsForPhase("confirming", { workflow: { capabilities: { slotSuggestion: false } } }));
  assert.ok(!tools.includes("propose_reschedule_slots"));
  assert.ok(tools.includes("reschedule_appointment"), "the plain reschedule tool is unaffected by this capability");
});

test("propose_reschedule_slots is offered when the workflow's slotSuggestion capability is true (InspectPoint)", () => {
  const tools = names(getToolsForPhase("confirming", { workflow: { capabilities: { slotSuggestion: true } } }));
  assert.ok(tools.includes("propose_reschedule_slots"));
});
