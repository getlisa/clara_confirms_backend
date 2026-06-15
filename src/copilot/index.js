/**
 * Copilot turn orchestrator.
 *
 * A "turn" is one engine_runs row (kind='copilot_turn') that streams over SSE.
 * - start():  a new user message → run the graph from a HumanMessage.
 * - resume(): a confirm/reject of a pending write action → resume the paused
 *             graph with Command({ resume }).
 *
 * Both share runTurn(), which streams events, then inspects graph state for a
 * pending interrupt (a write proposal). If present, it persists a
 * copilot_pending_actions row, emits `propose` + `awaiting_confirmation`, and
 * finishes the run (no mutation happened). Otherwise it finishes with the final
 * assistant text.
 */

const { HumanMessage } = require("@langchain/core/messages");
const { Command } = require("@langchain/langgraph");

const { Engine } = require("../engines/core/engine");
const broker = require("../engines/core/broker");
const callSettingsDb = require("../db/call-settings");
const { getGraph } = require("./graph/build");
const { extractText, pump } = require("./stream");
const persistence = require("./persistence");
const logger = require("../utils/logger");

const SUBSCRIBER_WAIT_MS = 4000;

async function start({ companyId, userId, conversationId, threadId, message }) {
  const engine = await Engine.create({ kind: "copilot_turn", companyId, startedBy: userId });
  runTurn(engine, {
    companyId,
    userId,
    conversationId,
    threadId,
    input: { messages: [new HumanMessage(message)] },
  }).catch((err) => engine.fail(err));
  return engine;
}

async function resume({ companyId, userId, conversationId, threadId, pendingActionId, decision }) {
  const engine = await Engine.create({ kind: "copilot_turn", companyId, startedBy: userId });
  runTurn(engine, {
    companyId,
    userId,
    conversationId,
    threadId,
    pendingActionId,
    decision,
    input: new Command({ resume: { decision } }),
  }).catch((err) => engine.fail(err));
  return engine;
}

async function runTurn(engine, { companyId, userId, conversationId, threadId, input, pendingActionId, decision }) {
  // Give the SSE client a moment to subscribe so early tokens aren't lost
  // (tokens are live-only, not persisted/replayed).
  await waitForSubscriber(String(engine.id), SUBSCRIBER_WAIT_MS);

  const settings = await callSettingsDb.getByCompanyId(companyId);
  const canMakeChanges = settings.agent_can_make_changes !== false;

  const ctx = {
    companyId,
    userId,
    conversationId,
    runId: engine.id,
    emit: (type, payload) => engine.emit(type, payload),
  };

  const graph = await getGraph();
  const config = {
    version: "v2",
    recursionLimit: 25,
    configurable: { thread_id: threadId, ctx, canMakeChanges },
  };

  await pump(engine, graph.streamEvents(input, config));

  // After streaming, check whether the graph paused on a write-confirmation interrupt.
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  const interrupts = (snapshot.tasks || []).flatMap((t) => t.interrupts || []);

  if (interrupts.length > 0) {
    const val = interrupts[0].value || {};
    const pending = await persistence.createPendingAction({
      companyId,
      threadId,
      runId: engine.id,
      userId,
      toolName: val.tool,
      args: val.args,
      preview: val.preview,
    });
    await engine.emit("propose", {
      pendingActionId: pending.id,
      tool_name: val.tool,
      preview: val.preview,
      args: val.args,
      expires_at: pending.expires_at,
    });
    await engine.emit("awaiting_confirmation", { pendingActionId: pending.id });
    await persistence.touchConversation(conversationId, companyId);
    await engine.finish({ status: "awaiting_confirmation", pendingActionId: pending.id });
    return;
  }

  // This was a resume turn — mark the pending action resolved.
  if (pendingActionId) {
    await persistence.setPendingActionStatus(
      pendingActionId,
      companyId,
      decision === "confirm" ? "executed" : "rejected"
    );
  }

  const finalText = lastAiText(snapshot);
  await maybeSetTitle(conversationId, companyId, snapshot);
  await persistence.touchConversation(conversationId, companyId);
  await engine.finish({ status: "done", text: finalText });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function waitForSubscriber(runId, timeoutMs) {
  return new Promise((resolve) => {
    if (broker.subscriberCount(runId) > 0) return resolve();
    const start = Date.now();
    const iv = setInterval(() => {
      if (broker.subscriberCount(runId) > 0 || Date.now() - start >= timeoutMs) {
        clearInterval(iv);
        resolve();
      }
    }, 50);
  });
}

function messagesOf(snapshot) {
  return snapshot?.values?.messages || [];
}

function lastAiText(snapshot) {
  const messages = messagesOf(snapshot);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const type = m?._getType?.() || m?.type;
    if (type === "ai") {
      const text = extractText(m);
      if (text) return text;
    }
  }
  return "";
}

/** Title a conversation from its first user message, once. */
async function maybeSetTitle(conversationId, companyId, snapshot) {
  try {
    const first = messagesOf(snapshot).find((m) => (m?._getType?.() || m?.type) === "human");
    const text = first ? extractText(first) : "";
    if (text) await persistence.setTitleIfEmpty(conversationId, companyId, text.slice(0, 80));
  } catch (err) {
    logger.debug("maybeSetTitle skipped", { error: err.message });
  }
}

/**
 * Read conversation message history from the checkpointer for the history endpoint.
 * Returns a UI-friendly list of {role, content, tool_calls?}.
 */
async function getHistory(threadId) {
  const graph = await getGraph();
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
  return messagesOf(snapshot).map((m) => {
    const type = m?._getType?.() || m?.type;
    const role = type === "human" ? "user" : type === "ai" ? "assistant" : type === "tool" ? "tool" : type;
    return {
      role,
      content: extractText(m) || (typeof m.content === "string" ? m.content : ""),
      ...(Array.isArray(m.tool_calls) && m.tool_calls.length
        ? { tool_calls: m.tool_calls.map((tc) => ({ name: tc.name, args: tc.args })) }
        : {}),
    };
  });
}

module.exports = { start, resume, getHistory };
