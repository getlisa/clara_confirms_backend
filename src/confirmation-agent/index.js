/**
 * Turn orchestrator — the integration point chat-links.js calls into instead
 * of Retell's client.chat.create()/createChatCompletion(). Unlike copilot's
 * index.js (SSE broker + persisted pending-actions, since copilot can pause
 * on a human-in-the-loop interrupt), this graph never interrupts and the
 * route layer (routes/chat-links.js) already owns the "typing" SSE
 * simulation — so this is a thin invoke-and-read-back layer over the graph's
 * own PostgresSaver-checkpointed state.
 *
 * The chat_links token IS the LangGraph thread_id directly — no new column,
 * no separate session concept to create/reopen/expire (unlike Retell's
 * chat_id, the checkpointer has no "ended" state to detect).
 */

const { HumanMessage } = require("@langchain/core/messages");
const { getGraph } = require("./graph/build");
const db = require("../db");
const chatLinksDb = require("../db/chat-links");
const { postConfirmationAgentComment } = require("../services/servicetrade-comments");
const { resolveContact } = require("./tools/confirmer-label");
const logger = require("../utils/logger");

// Tool calls whose outcome is worth recording on the ServiceTrade job when
// the conversation ends — reporting/read-only tools (list_upcoming_appointments,
// get_service_link, report_customer_intent) are deliberately excluded.
const ACTIONABLE_TOOLS = new Set([
  "confirm_appointment", "confirm_job_appointments",
  "reschedule_appointment", "cancel_appointment", "create_appointment",
]);

// Synthetic first "user" turn so the model reliably opens in the right
// (chat, not voice) register — same idea as chat-links.js's
// CHAT_TRIGGER_MESSAGE, filtered back out in toVisibleMessages below.
const TRIGGER_MESSAGE = "(This is a text chat, not a phone call. Please begin now with your chat-appropriate opening message.)";

async function resolveJobRefs(companyId, jobId) {
  const { rows } = await db.query(
    `SELECT j.external_ref AS job_ref, cu.external_ref AS customer_ref,
            cu.email AS customer_email, cu.phone AS customer_phone
       FROM jobs j LEFT JOIN customers cu ON cu.id = j.customer_id
      WHERE j.id = $1 AND j.company_id = $2`,
    [jobId, companyId]
  );
  return {
    jobRef: rows[0]?.job_ref ?? null,
    customerRef: rows[0]?.customer_ref ?? null,
    customerEmail: rows[0]?.customer_email ?? null,
    customerPhone: rows[0]?.customer_phone ?? null,
  };
}

/**
 * Who this conversation is actually WITH — the customer themself
 * (recipientContactId null) or a different named contact (e.g. a property
 * manager, migration 081's confirmation-recipients feature). Used for the
 * greeting (address them by their own name) and the service-link step
 * (present known email/phone instead of asking blind).
 */
async function resolveRecipient(companyId, recipientContactId, customerEmail, customerPhone) {
  if (recipientContactId) {
    const contact = await resolveContact(companyId, recipientContactId);
    return {
      recipientName: contact?.name ?? null,
      recipientEmail: contact?.email ?? null,
      recipientPhone: contact?.phone ?? null,
    };
  }
  return { recipientName: null, recipientEmail: customerEmail, recipientPhone: customerPhone };
}

function extractText(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.filter((p) => p?.type === "text").map((p) => p.text).join("");
  return "";
}

/**
 * Keep only real chat turns — strip the synthetic trigger and raw tool
 * plumbing — but surface a successful get_service_link call as a structured
 * `type: "service_link"` entry, same contract chat-links.js's
 * filterVisibleMessages already promises the frontend.
 *
 * `includeUser` controls whether the customer's own messages are included:
 * true for a full-history replay (GET /chat-links/:token, which needs the
 * whole transcript), false for a single turn's result (POST .../messages —
 * the frontend already renders the customer's own message optimistically
 * the moment they hit send, and the SSE contract promises every event is
 * role:"agent"; echoing it back was a real bug — the customer's just-sent
 * message was appearing as a role:"user" message_delta/message_complete).
 */
function toVisibleMessages(messages, { includeUser = true } = {}) {
  const out = [];
  for (const m of messages) {
    const type = m?._getType?.() || m?.type;
    if (type === "human") {
      if (!includeUser) continue;
      const text = extractText(m);
      if (text && text !== TRIGGER_MESSAGE) out.push({ role: "user", content: text, created_at: null });
    } else if (type === "ai") {
      const text = extractText(m);
      if (text) out.push({ role: "agent", content: text, created_at: null });
    } else if (type === "tool" && m.name === "get_service_link") {
      let parsed;
      try {
        parsed = JSON.parse(m.content);
      } catch {
        parsed = null;
      }
      if (parsed?.success && parsed?.url) {
        out.push({ role: "agent", type: "service_link", url: parsed.url, job_name: parsed.job_name ?? null, created_at: null });
      }
    }
  }
  return out;
}

function parseToolResult(content) {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * `on_chat_model_end` hands back either the AIMessage itself or an LLMResult
 * wrapping it, depending on the provider integration — normalize both.
 * (Same shape-tolerance as copilot/stream.js's private endMessage.)
 */
function endMessage(output) {
  if (!output) return null;
  if (output.tool_calls !== undefined || typeof output.content !== "undefined") return output;
  return output.generations?.[0]?.[0]?.message || null;
}

/**
 * Live token pump for one turn.
 *
 * Emits the SAME visible-message shapes toVisibleMessages produces, in the
 * same order, but as they happen rather than after the whole turn:
 *
 *   delta …  → message   (one AI generation)
 *   message              (a get_service_link result, when it lands)
 *   delta …  → message   (the generation after the tool loop)
 *
 * The `message` event after a run of deltas carries the identical full text
 * those deltas spelled out — the route forwards them as `message_delta` +
 * `message_complete`, exactly the contract the frontend already consumes from
 * the old simulated-typing implementation. Nothing about the wire protocol
 * changes; only the deltas become real.
 *
 * Text is emitted for tool-calling ("thinking") generations too, because
 * toVisibleMessages has always shown those — this must not quietly start
 * hiding messages the transcript replay (GET /chat-links/:token) will show.
 */
async function pumpTurn(graph, input, config, onEvent) {
  for await (const ev of graph.streamEvents(input, { ...config, version: "v2" })) {
    switch (ev.event) {
      case "on_chat_model_stream": {
        const chunk = extractText(ev.data?.chunk);
        if (chunk) await onEvent({ type: "delta", chunk });
        break;
      }
      case "on_chat_model_end": {
        const text = extractText(endMessage(ev.data?.output));
        if (text) await onEvent({ type: "message", message: { role: "agent", content: text, created_at: null } });
        break;
      }
      case "on_tool_end": {
        if (ev.name !== "get_service_link") break;
        const output = ev.data?.output;
        const parsed = parseToolResult(typeof output === "string" ? output : output?.content);
        if (parsed?.success && parsed?.url) {
          await onEvent({
            type: "message",
            message: { role: "agent", type: "service_link", url: parsed.url, job_name: parsed.job_name ?? null, created_at: null },
          });
        }
        break;
      }
      default:
        break;
    }
  }
}

function describeAction(name, args, result) {
  switch (name) {
    case "confirm_appointment":
      // already_confirmed means the tool no-op'd (nothing changed) — don't
      // report a "confirmed" outcome that didn't actually happen this turn.
      return result.already_confirmed ? null : `Customer confirmed appointment #${result.appointment_id ?? args.appointment_id}.`;
    case "confirm_job_appointments": {
      const ids = result.confirmed || [];
      return ids.length ? `Customer confirmed ${ids.length} appointment(s): #${ids.join(", #")}.` : null;
    }
    case "reschedule_appointment":
      return `Customer rescheduled appointment #${result.appointment_id ?? args.appointment_id} to ${result.scheduled_start ?? args.scheduled_start}.`;
    case "cancel_appointment":
      return args.scope === "entire_job"
        ? `Customer cancelled the job (reason: ${args.reason || "not specified"}).`
        : `Customer cancelled appointment #${result.appointment_id ?? args.appointment_id} (reason: ${args.reason || "not specified"}).`;
    case "create_appointment":
      return `Customer booked a new appointment for ${result.scheduled_start ?? args.scheduled_start}.`;
    default:
      return null;
  }
}

/**
 * Deterministic outcome summary for a completed conversation — built
 * entirely from the real tool calls the model made and their real results
 * (already durably stored in the checkpointer), never from any LLM-derived
 * judgment. One line per successful actionable tool call; failed calls
 * (result.success !== true) are skipped, same as an "unclear outcome" is
 * skipped in the voice/SMS call flow.
 */
function summarizeOutcome(messages) {
  const resultByCallId = new Map();
  for (const m of messages) {
    const type = m?._getType?.() || m?.type;
    if (type === "tool" && m.tool_call_id) resultByCallId.set(m.tool_call_id, m.content);
  }

  const lines = [];
  const appointmentIds = new Set();
  for (const m of messages) {
    const type = m?._getType?.() || m?.type;
    if (type !== "ai" || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      if (!ACTIONABLE_TOOLS.has(tc.name)) continue;
      const result = parseToolResult(resultByCallId.get(tc.id));
      if (!result?.success) continue;
      const line = describeAction(tc.name, tc.args, result);
      if (line) lines.push(line);
      // Which visits were actually touched — the CRM comment's summary names
      // their services and dates, so it must not guess from the whole job.
      for (const id of [result.appointment_id ?? tc.args?.appointment_id, ...(result.confirmed || [])]) {
        if (id != null && String(id).trim() !== "") appointmentIds.add(String(id));
      }
    }
  }
  return { lines, appointmentIds: [...appointmentIds] };
}

async function runGraph(threadId, ctx, input, onEvent = null) {
  const graph = await getGraph();
  const config = { recursionLimit: 25, configurable: { thread_id: threadId, ctx } };
  const before = (await graph.getState(config)).values?.messages || [];
  // streamEvents drives the graph identically to invoke — same nodes, same
  // checkpoint writes — it only additionally surfaces the callbacks. So the
  // streaming and non-streaming paths cannot diverge in what they persist.
  if (onEvent) await pumpTurn(graph, input, config, onEvent);
  else await graph.invoke(input, config);
  const after = (await graph.getState(config)).values?.messages || [];
  const newMessages = after.slice(before.length);

  const endedNow = newMessages.some((m) => {
    const type = m?._getType?.() || m?.type;
    return type === "ai" && Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.name === "end_conversation");
  });
  if (endedNow) {
    // Without this, chat_links.state stayed at whatever it last was
    // (e.g. "service_link_sent") forever — the frontend had no way to tell
    // the conversation had actually concluded, so the input box never went
    // away. chat_ended already existed in the state CHECK constraint
    // (previously only ever meant "session timed out from inactivity" — a
    // scenario that no longer applies now that the checkpointer keeps
    // threads alive indefinitely); it now also covers "the agent explicitly
    // wrapped up," which is the far more common way a conversation ends.
    await chatLinksDb.setStateByToken(threadId, "chat_ended").catch((err) =>
      logger.warn("ConfirmationAgent: failed to set chat_ended state", { error: err.message, threadId })
    );

    const { lines: summaryLines, appointmentIds } = summarizeOutcome(after);
    await postConfirmationAgentComment({
      companyId: ctx.companyId, jobId: ctx.jobId, threadId,
      summaryLines, appointmentIds, messageCount: after.length,
      // Who we were actually talking to — a nominated contact when the link was
      // sent to one, otherwise the customer record.
      recipientName: ctx.recipientName || null,
    }).catch((err) => logger.warn("ConfirmationAgent: outcome comment post failed", { error: err.message, threadId }));
  }

  return toVisibleMessages(newMessages, { includeUser: false });
}

/**
 * Ensure the conversation has an opening agent message, without duplicating
 * one on a second GET of the same link — mirrors chat-links.js's
 * getOrCreateSession, but there's no dead-session case to reopen: the
 * checkpointer keeps the thread alive indefinitely.
 */
async function ensureOpened({ companyId, jobId, token, companyName, recipientContactId = null, linkAppointmentId = null }) {
  const { jobRef, customerRef, customerEmail, customerPhone } = await resolveJobRefs(companyId, jobId);
  const { recipientName, recipientEmail, recipientPhone } = await resolveRecipient(companyId, recipientContactId, customerEmail, customerPhone);
  const ctx = {
    companyId, jobId, threadId: token, jobRef, customerRef, companyName, recipientContactId, linkAppointmentId,
    recipientName, recipientEmail, recipientPhone,
  };

  const graph = await getGraph();
  const snapshot = await graph.getState({ configurable: { thread_id: token } });
  const already = (snapshot.values?.messages || []).length > 0;
  if (already) return { messages: toVisibleMessages(snapshot.values.messages) };

  const messages = await runGraph(token, ctx, { messages: [new HumanMessage(TRIGGER_MESSAGE)] });
  return { messages };
}

/**
 * Run one customer turn.
 *
 * @param {function|null} [onEvent] — called with `{type:"delta",chunk}` /
 *   `{type:"message",message}` as the turn unfolds. Omit it for a plain
 *   await-the-whole-turn call; the returned `messages` are the same either
 *   way, so a caller that streams must NOT also render the return value.
 */
async function sendMessage({ companyId, jobId, token, companyName, content, recipientContactId = null, linkAppointmentId = null }, onEvent = null) {
  const { jobRef, customerRef, customerEmail, customerPhone } = await resolveJobRefs(companyId, jobId);
  const { recipientName, recipientEmail, recipientPhone } = await resolveRecipient(companyId, recipientContactId, customerEmail, customerPhone);
  const ctx = {
    companyId, jobId, threadId: token, jobRef, customerRef, companyName, recipientContactId, linkAppointmentId,
    recipientName, recipientEmail, recipientPhone,
  };
  const messages = await runGraph(token, ctx, { messages: [new HumanMessage(content)] }, onEvent);
  return { messages };
}

module.exports = { ensureOpened, sendMessage };
