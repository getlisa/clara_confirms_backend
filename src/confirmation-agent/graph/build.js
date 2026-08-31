/**
 * The confirmation agent graph — a genuinely state-driven StateGraph, unlike
 * copilot's generic two-node ReAct loop.
 *
 *   START → load_context → agent ⇄ tools → recompute_context → agent … → END
 *
 * `phase` is computed by CODE from real job/appointment data
 * (load_context/recompute_context), never by the LLM's own judgment — the
 * `agent` node only offers the tool subset (registry.getToolsForPhase) and
 * prompt (prompt.build) appropriate to the current phase. This is what makes
 * it structurally state-driven: an `all_confirmed` conversation cannot call
 * confirm_appointment because it was never bound to the model, not because
 * an instruction told it not to.
 *
 * Appointment facts are injected directly into the system prompt from
 * `state.jobCtx` on every `agent` invocation — no get_appointments tool is
 * needed (see prompt.js's header comment for why that's safe here but
 * wasn't for the Retell-based design it replaces).
 *
 * Built once as a memoized singleton, same convention as copilot's
 * graph/build.js. Tenant/job context is injected per invocation via
 * config.configurable.ctx.
 */

const { StateGraph, Annotation, MessagesAnnotation, START, END } = require("@langchain/langgraph");
const { ToolNode } = require("@langchain/langgraph/prebuilt");
const { SystemMessage } = require("@langchain/core/messages");

const { getCheckpointer } = require("./checkpointer");
const { invokeWithFailover } = require("./model");
const { extractText } = require("../../copilot/stream");
const prompt = require("./prompt");
const { getToolsForPhase, byName } = require("../tools/registry");
const { buildJobConfirmationContext } = require("../../services/job-confirmation-context");
const { logCall } = require("../../db/llm-call-logs");
const serviceLineDescriptionsDb = require("../../db/service-line-descriptions");
const onsiteInstructionsDb = require("../../db/onsite-instructions");
const { resolveSlugForCompany } = require("../../services/crm");
const { getWorkflow } = require("../workflows");
const db = require("../../db");
const { PROPOSE_REMAINING_TRIGGER, parseCardTrigger } = require("../actions");
const logger = require("../../utils/logger");

const ConfirmationState = Annotation.Root({
  ...MessagesAnnotation.spec,
  phase: Annotation({ reducer: (_prev, next) => next, default: () => "loading" }),
  jobCtx: Annotation({ reducer: (_prev, next) => next ?? _prev, default: () => null }),
  ended: Annotation({ reducer: (_prev, next) => next, default: () => false }),
  // Set when this link's target appointment (ctx.linkAppointmentId) was
  // already confirmed by a DIFFERENT recipient's separate conversation —
  // see resolveConfirmedByOther below.
  confirmedByOtherLabel: Annotation({ reducer: (_prev, next) => next, default: () => null }),
  // Company's reference descriptions of what a visit for each service line
  // actually involves (see migrations/084) — small, static-ish company data,
  // cheap to refresh alongside jobCtx every turn.
  serviceLineDescriptions: Annotation({ reducer: (_prev, next) => next ?? _prev, default: () => [] }),
  // Company's structured onsite instructions (migrations/101) — general +
  // per-service-line, unfiltered; prompt.js's derive() matches them against
  // the current appointment's own service_line. Same refresh cadence as
  // serviceLineDescriptions above.
  onsiteInstructions: Annotation({ reducer: (_prev, next) => next ?? _prev, default: () => [] }),
  // Which CRM this company uses (services/crm's <slug>_integration
  // resolution) — resolves which confirmation-agent/workflows/*.js module
  // shapes this turn's prompt/tool surface. Refreshed alongside jobCtx
  // (cheap, and a company could in principle switch CRMs mid-conversation).
  workflowSlug: Annotation({ reducer: (_prev, next) => next ?? _prev, default: () => "servicetrade" }),
});

function phaseFromContext(ctx) {
  if (!ctx.ok) return "no_appointment";
  if (ctx.counts.upcoming === 0) return "no_appointment";
  if (ctx.counts.all_confirmed) return "all_confirmed";
  return "confirming";
}

/**
 * A job can have several recipients (migration 081) each with their own
 * chat_links token for the same appointment — confirmation itself is one
 * global flag, not per-recipient, so if a DIFFERENT recipient's own
 * conversation already confirmed THIS link's target appointment (stamped by
 * confirm-appointment.js/confirm-job-appointments.js), this conversation
 * should recognize that immediately rather than asking as if nothing has
 * happened. Returns the stamped label, or null when not applicable (no
 * linked appointment, not yet confirmed, or confirmed by this same thread).
 */
async function resolveConfirmedByOther(companyId, linkAppointmentId, threadId) {
  if (!linkAppointmentId) return null;
  const { rows } = await db.query(
    `SELECT customer_confirmed, additional_information FROM appointments WHERE id = $1 AND company_id = $2`,
    [linkAppointmentId, companyId]
  );
  const row = rows[0];
  if (!row || row.customer_confirmed !== true) return null;
  const info = row.additional_information || {};
  if (!info.confirmed_by_thread_id || info.confirmed_by_thread_id === threadId) return null;
  return info.confirmed_by_label || "the customer";
}

let _graphPromise;

async function getGraph() {
  if (!_graphPromise) {
    _graphPromise = buildGraph().catch((err) => {
      _graphPromise = undefined;
      throw err;
    });
  }
  return _graphPromise;
}

async function buildGraph() {
  async function loadContext(_state, config) {
    const { companyId, jobId, threadId, linkAppointmentId } = config?.configurable?.ctx || {};
    // None of these three depend on each other's result — run concurrently
    // rather than paying for three sequential round trips on every turn.
    const [ctx, confirmedByOtherLabel, serviceLineDescriptions, onsiteInstructions, workflowSlug] = await Promise.all([
      buildJobConfirmationContext(companyId, jobId),
      resolveConfirmedByOther(companyId, linkAppointmentId, threadId),
      serviceLineDescriptionsDb.listByCompany(companyId),
      onsiteInstructionsDb.listByCompany(companyId),
      resolveSlugForCompany(companyId),
    ]);
    return { jobCtx: ctx, phase: phaseFromContext(ctx), confirmedByOtherLabel, serviceLineDescriptions, onsiteInstructions, workflowSlug };
  }

  async function agentNode(state, config) {
    const ctx = config?.configurable?.ctx || {};

    // True only before any AI message exists in this thread — matches
    // exactly when index.js's ensureOpened invokes with the synthetic
    // trigger message, so the opening-greeting instruction never resurfaces
    // mid-conversation.
    const isOpeningTurn = !state.messages.some((m) => (m._getType?.() || m.type) === "ai");

    // True only on the ONE turn triggered right after a card-driven
    // confirm/reschedule leaves other appointments unconfirmed — same
    // "check the last message" structural pattern as isOpeningTurn above.
    const lastMessage = state.messages[state.messages.length - 1];
    const lastMessageType = lastMessage?._getType?.() || lastMessage?.type;
    const lastMessageContent = lastMessageType === "human" && typeof lastMessage.content === "string" ? lastMessage.content : "";
    const isProposeRemainingTurn = lastMessageContent === PROPOSE_REMAINING_TRIGGER;

    // A card button (confirm/reschedule/cancel/bulk-confirm/decline-remaining)
    // routed through the agent for real — see actions.js's CARD_TRIGGER_PREFIX.
    // The tool name travels in the marker; its real argument values travel
    // separately via ctx.cardTriggerArgs (never trust the model to relay
    // them faithfully — see the promoted tool handlers).
    const cardTriggerTool = parseCardTrigger(lastMessageContent);

    // Whichever of the two applies (never both — each is its own distinct
    // trigger message) becomes the ONE tool bound to the model this turn,
    // both for what's OFFERED (registry.js) and, critically, for what the
    // API is told to FORCE (model.js's tool_choice) — binding alone doesn't
    // guarantee the model actually calls it; forcing does.
    const exclusiveTool = isProposeRemainingTurn ? "propose_remaining_appointments" : cardTriggerTool;

    // Which CRM's chat workflow shapes this turn — resolved once in
    // load_context/recompute_context (a real DB check), read here every
    // turn. Falls back to ServiceTrade if somehow unset (getWorkflow's own
    // fallback), never to an error — a workflow lookup must never be able
    // to break a live turn.
    const workflow = getWorkflow(state.workflowSlug);

    const tools = getToolsForPhase(state.phase, { isOpeningTurn, exclusiveTool, workflow });
    // state.jobCtx (buildJobConfirmationContext's raw result) has no `phase`
    // field of its own — phase is a separate Annotation this graph computes
    // alongside it (phaseFromContext) — so it must be merged in explicitly;
    // prompt.js's phase-specific branches read `ctx.phase`.
    const sys = new SystemMessage(prompt.build({ ...state.jobCtx, phase: state.phase }, {
      companyName: ctx.companyName,
      companyPhone: ctx.companyPhone,
      representativeName: ctx.representativeName,
      isOpeningTurn,
      isProposeRemainingTurn,
      cardTriggerTool,
      cardTriggerArgs: ctx.cardTriggerArgs || null,
      confirmedByOtherLabel: state.confirmedByOtherLabel,
      serviceLineDescriptions: state.serviceLineDescriptions,
      onsiteInstructions: state.onsiteInstructions,
      recipientName: ctx.recipientName,
      recipientEmail: ctx.recipientEmail,
      recipientPhone: ctx.recipientPhone,
      confirmedBy: ctx.confirmedBy || null,
      workflow,
    }));
    const message = await invokeWithFailover(tools, [sys, ...state.messages], config, ctx, exclusiveTool);

    // The human message that triggered THIS call — only present when this is
    // the first LLM call of a turn; a tool-loop re-invocation's last prior
    // message is a ToolMessage instead, so humanMessage stays null there.
    const lastPrior = state.messages[state.messages.length - 1];
    const lastPriorType = lastPrior?._getType?.() || lastPrior?.type;
    // Fire-and-forget — pure telemetry that nothing downstream this turn
    // reads, same precedent as actions.js's CRM mirror calls. Awaiting this
    // put a DB insert directly in the customer-visible response path for no
    // benefit; a failure here already only warns, never fails the turn.
    logCall({
      companyId: ctx.companyId,
      jobId: ctx.jobId,
      threadId: ctx.threadId,
      phase: state.phase,
      provider: message.response_metadata?.model_name || message.response_metadata?.model || "unknown",
      humanMessage: lastPriorType === "human" ? extractText(lastPrior) || null : null,
      aiMessage: extractText(message) || null,
      toolCalls: message.tool_calls,
      usage: message.usage_metadata,
    }).catch((err) => logger.warn("ConfirmationAgent: LLM call log failed", { error: err.message, threadId: ctx.threadId }));

    return { messages: [message] };
  }

  // A tool_call always gets routed to "tools" first — including
  // end_conversation's — so its ToolMessage is appended before the graph
  // ends. Ending straight from "agent" without executing the call would
  // leave a dangling unanswered tool_call in the checkpointed history; if
  // the customer sent one more message afterward, replaying that history
  // into the model would be rejected (every tool_call needs a matching
  // result message first).
  function shouldContinue(state) {
    const last = state.messages[state.messages.length - 1];
    return last && Array.isArray(last.tool_calls) && last.tool_calls.length > 0 ? "tools" : END;
  }

  // After tools run, check whether the AI message that triggered them called
  // end_conversation — if so, stop here instead of looping back to agent.
  // propose_remaining_appointments stops the same way unconditionally: it's
  // bound EXCLUSIVELY (registry.js), so it's never called any other way.
  //
  // The card-trigger tools (confirm_appointment/reschedule_appointment/
  // cancel_appointment/confirm_job_appointments/decline_remaining_appointments/
  // capture_confirmer_identity) are DIFFERENT: the same names are also real
  // free-text tools, called during a normal conversation where looping back
  // is required (deliver the arrival window, offer the service link, check
  // in on other appointments on the job...). Stopping unconditionally on
  // those names would break that flow. So this checks the
  // message that actually STARTED this agent turn — a card-trigger marker
  // means it was single-shot; a normal customer message or a mid-loop
  // ToolMessage means it wasn't.
  function afterTools(state) {
    const messages = state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      const isAiWithCalls = (m?._getType?.() === "ai" || m?.type === "ai") && Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      if (isAiWithCalls) {
        const names = m.tool_calls.map((tc) => tc.name);
        if (names.includes("end_conversation") || names.includes("propose_remaining_appointments")) return END;

        const prior = messages[i - 1];
        const priorType = prior?._getType?.() || prior?.type;
        const priorContent = priorType === "human" && typeof prior.content === "string" ? prior.content : "";
        return parseCardTrigger(priorContent) ? END : "recompute_context";
      }
    }
    return "recompute_context";
  }

  // Every tool is reachable by the ToolNode — the phase gate is enforced by
  // which ones are BOUND to the model in agentNode, not by hiding them from
  // the executor (a stale tool_call for a since-changed phase should still
  // execute cleanly rather than error).
  const { tool } = require("@langchain/core/tools");
  const toolNode = new ToolNode(
    [...byName.values()].map((h) => tool(h.run, { name: h.name, description: h.description, schema: h.schema }))
  );

  async function recomputeContext(_state, config) {
    const { companyId, jobId, threadId, linkAppointmentId } = config?.configurable?.ctx || {};
    const [ctx, confirmedByOtherLabel, serviceLineDescriptions, onsiteInstructions, workflowSlug] = await Promise.all([
      buildJobConfirmationContext(companyId, jobId),
      resolveConfirmedByOther(companyId, linkAppointmentId, threadId),
      serviceLineDescriptionsDb.listByCompany(companyId),
      onsiteInstructionsDb.listByCompany(companyId),
      resolveSlugForCompany(companyId),
    ]);
    return { jobCtx: ctx, phase: phaseFromContext(ctx), confirmedByOtherLabel, serviceLineDescriptions, onsiteInstructions, workflowSlug };
  }

  const checkpointer = await getCheckpointer();

  return new StateGraph(ConfirmationState)
    .addNode("load_context", loadContext)
    .addNode("agent", agentNode)
    .addNode("tools", toolNode)
    .addNode("recompute_context", recomputeContext)
    .addEdge(START, "load_context")
    .addEdge("load_context", "agent")
    .addConditionalEdges("agent", shouldContinue, { tools: "tools", [END]: END })
    .addConditionalEdges("tools", afterTools, { recompute_context: "recompute_context", [END]: END })
    .addEdge("recompute_context", "agent")
    .compile({ checkpointer });
}

module.exports = { getGraph, phaseFromContext };
