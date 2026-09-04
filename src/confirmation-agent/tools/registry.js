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
  require("./handlers/propose-reschedule-slots"),
  require("./handlers/cancel-appointment"),
  require("./handlers/create-appointment"),
  require("./handlers/resolve-service-link-contact"),
  require("./handlers/get-service-link"),
  require("./handlers/report-customer-intent"),
  require("./handlers/end-conversation"),
  require("./handlers/propose-remaining-appointments"),
  require("./handlers/decline-remaining-appointments"),
  require("./handlers/capture-confirmer-identity"),
];

const byName = new Map(HANDLERS.map((h) => [h.name, h]));

// Which tool names are offered in each phase. `end_conversation` is always
// available — the agent must always have a way to stop. Service-link tools
// are offered once the phase is past the get-something-confirmed problem
// (they simply don't apply to no_appointment) and inside confirming/
// all_confirmed, matching today's "only after a confirmation" prompt rule
// (enforced by phase gating instead of the model policing its own timing).
//
// decline_remaining_appointments is ALSO offered here (not just as a card-
// trigger exclusiveTool) so a customer who does an entire conversation in
// free text has a real way to close the "other appointments" loop — without
// this, end_conversation never stamps chat_links.remaining_addressed_at, and
// POST /:token/end 409s forever for a free-text-only conversation. It does
// not apply to no_appointment (nothing booked yet to decline).
//
// capture_confirmer_identity is offered in every phase including
// no_appointment: identity should be captured before the FIRST mutating
// action of any kind, and create_appointment (no_appointment's only action)
// is one of those.
const PHASE_TOOLS = {
  confirming: ["confirm_appointment", "confirm_job_appointments", "list_upcoming_appointments", "reschedule_appointment", "propose_reschedule_slots", "cancel_appointment", "resolve_service_link_contact", "get_service_link", "decline_remaining_appointments", "capture_confirmer_identity"],
  all_confirmed: ["list_upcoming_appointments", "reschedule_appointment", "propose_reschedule_slots", "cancel_appointment", "resolve_service_link_contact", "get_service_link", "decline_remaining_appointments", "capture_confirmer_identity"],
  no_appointment: ["create_appointment", "capture_confirmer_identity"],
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
/**
 * @param {object} [opts]
 * @param {boolean} [opts.isOpeningTurn] — true when the agent has not spoken yet.
 *   On that turn the customer has said NOTHING, so there is no intent to report
 *   and nothing to end. Binding those tools anyway caused a real duplicate
 *   greeting: the model emitted its opening AND called report_customer_intent in
 *   the same message, the tool call routed agent → tools → recompute_context →
 *   agent, and the second pass greeted all over again. Withholding the tool is
 *   the structural fix — the same principle as the phase gate itself: constrain
 *   what the model CAN do, rather than instructing it not to.
 */
/**
 * @param {string|null} [opts.exclusiveTool] — a tool name to bind
 *   EXCLUSIVELY, ignoring phase/isOpeningTurn entirely. Used for every
 *   single-shot, structurally-forced turn: the agent's own proactive
 *   "confirm the rest?" ask (`propose_remaining_appointments`) and every
 *   card-driven action routed through the agent
 *   (`confirm_appointment`/`reschedule_appointment`/`cancel_appointment`/
 *   `confirm_job_appointments`/`decline_remaining_appointments` — see
 *   actions.js's CARD_TRIGGER_PREFIX). The model structurally cannot do
 *   anything else this turn — same philosophy as the phase gate itself,
 *   and paired with `model.js`'s `tool_choice` forcing so it's not just
 *   "the only tool offered" but "the tool the API guarantees gets called."
 */
// Tools that only make sense when the resolved workflow (confirmation-agent/
// workflows/*.js) declares the matching capability — a company on a CRM
// with no customer-facing job-tracking link must never see these bound,
// the same "constrain what's structurally possible" principle PHASE_TOOLS
// itself already applies per-phase.
const CAPABILITY_TOOLS = {
  serviceLink: ["resolve_service_link_contact", "get_service_link"],
  slotSuggestion: ["propose_reschedule_slots"],
};

/**
 * @param {object} [opts.workflow] — the resolved confirmation-agent/workflows/*
 *   module (defaults to every capability being on when omitted, so existing
 *   callers/tests that don't pass one keep today's ServiceTrade behavior).
 */
function getToolsForPhase(phase, { isOpeningTurn = false, exclusiveTool = null, workflow = null } = {}) {
  const toolsByName = build();
  if (exclusiveTool) {
    return [toolsByName.get(exclusiveTool)].filter(Boolean);
  }
  const capabilities = workflow?.capabilities || {};
  const withheld = new Set(
    Object.entries(CAPABILITY_TOOLS)
      .filter(([cap]) => capabilities[cap] === false)
      .flatMap(([, names]) => names)
  );
  const names = new Set([
    ...(PHASE_TOOLS[phase] || []),
    ...(isOpeningTurn ? [] : ["end_conversation", "report_customer_intent"]),
  ]);
  for (const n of withheld) names.delete(n);
  return [...names].map((n) => toolsByName.get(n)).filter(Boolean);
}

module.exports = { HANDLERS, byName, getToolsForPhase };
