/**
 * Confirmation-agent tool registry — same shape as copilot's
 * (src/copilot/tools/registry.js): each handler exports
 * { name, description, schema (zod), run }, turned into LangChain tools via
 * the tool() helper.
 *
 * Unlike copilot (which always offers every tool), this registry is
 * PHASE-AWARE: `getToolsForPhase` returns only the subset appropriate to the
 * current computed phase, so e.g. an `all_confirmed` conversation literally
 * cannot call `confirm_appointment` — it was never bound to the model. This
 * is the structural half of "state driven": the LLM's available ACTIONS are
 * constrained by code-computed state, not just its instructions.
 */

const { tool } = require("@langchain/core/tools");

const HANDLERS = [
  require("./handlers/confirm-appointment"),
  require("./handlers/confirm-job-appointments"),
  require("./handlers/list-upcoming-appointments"),
  require("./handlers/reschedule-appointment"),
  require("./handlers/cancel-appointment"),
  require("./handlers/create-appointment"),
  require("./handlers/resolve-service-link-contact"),
  require("./handlers/get-service-link"),
  require("./handlers/report-customer-intent"),
  require("./handlers/end-conversation"),
];

const byName = new Map(HANDLERS.map((h) => [h.name, h]));

// Which tool names are offered in each phase. `end_conversation` is always
// available — the agent must always have a way to stop. Service-link tools
// are offered once the phase is past the get-something-confirmed problem
// (they simply don't apply to no_appointment) and inside confirming/
// all_confirmed, matching today's "only after a confirmation" prompt rule
// (enforced by phase gating instead of the model policing its own timing).
const PHASE_TOOLS = {
  confirming: ["confirm_appointment", "confirm_job_appointments", "list_upcoming_appointments", "reschedule_appointment", "cancel_appointment", "resolve_service_link_contact", "get_service_link"],
  all_confirmed: ["list_upcoming_appointments", "reschedule_appointment", "cancel_appointment", "resolve_service_link_contact", "get_service_link"],
  no_appointment: ["create_appointment"],
};

let _toolsByName;
function build() {
  if (!_toolsByName) {
    _toolsByName = new Map(
      HANDLERS.map((h) => [h.name, tool(h.run, { name: h.name, description: h.description, schema: h.schema })])
    );
  }
  return _toolsByName;
}

/** @returns {object[]} the LangChain tool objects offered for this phase, always including end_conversation. */
function getToolsForPhase(phase) {
  const toolsByName = build();
  const names = new Set([...(PHASE_TOOLS[phase] || []), "end_conversation", "report_customer_intent"]);
  return [...names].map((n) => toolsByName.get(n)).filter(Boolean);
}

module.exports = { HANDLERS, byName, getToolsForPhase };
