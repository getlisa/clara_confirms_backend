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
const sendEventsDb = require("../db/chat-link-send-events");
const llmLogsDb = require("../db/llm-call-logs");
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
async function resolveRecipient(companyId, recipientContactId, customerEmail, customerPhone, snapshot = null, token = null) {
  // Resolved as three independent fields rather than three whole-object
  // branches: a link sent after migration 095 always has an address snapshotted
  // but usually no NAME, so returning early on "the snapshot has something"
  // would skip the very lookups that can supply the name.
  let name = snapshot?.name ?? null;
  let email = snapshot?.email ?? null;
  let phone = snapshot?.phone ?? null;

  // 1. The nominated contact, when the link was addressed to one.
  if (!name && recipientContactId) {
    const contact = await resolveContact(companyId, recipientContactId);
    name = contact?.name ?? null;
    email = email ?? contact?.email ?? null;
    phone = phone ?? contact?.phone ?? null;
  }

  // 2. Fallback: work backwards from the delivery itself — token → the address
  //    the email/SMS actually went to → the contact who owns that address. This
  //    is what covers the ordinary case, where nobody was NOMINATED but the link
  //    still went to a real person's inbox or phone. On live data it names 8 of
  //    10 links that would otherwise have had no name at all.
  if (!name && token) {
    const sent = await sendEventsDb.resolveRecipientForToken(companyId, token)
      .catch((err) => {
        logger.warn("ConfirmationAgent: recipient lookup from send events failed", { error: err.message, token });
        return null;
      });
    if (sent) {
      name = sent.name ?? null;
      email = email ?? sent.email ?? null;
      phone = phone ?? sent.phone ?? null;
    }
  }

  // A null name is left null. The customer record is an account, not a person —
  // every customer on the platform has first_name/last_name NULL and a full_name
  // like "Holiday Inn Express-NE City" — so there is no human name to fall back
  // to here, only an organisation the agent must not greet.
  return {
    recipientName: name,
    recipientEmail: email ?? customerEmail ?? null,
    recipientPhone: phone ?? customerPhone ?? null,
  };
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
/**
 * Tools whose outcome is worth a CRM comment when a chat EXPIRES rather than
 * closing properly.
 *
 * Narrower than ACTIONABLE_TOOLS on purpose: `create_appointment` is excluded by
 * product decision, so a chat that booked a visit and then lapsed posts nothing.
 * This divergence is deliberate — do not "fix" it by reusing ACTIONABLE_TOOLS.
 */
const EXPIRY_OUTCOME_TOOLS = new Set([
  "confirm_appointment", "confirm_job_appointments",
  "reschedule_appointment", "cancel_appointment",
]);

function summarizeOutcome(messages, { tools = ACTIONABLE_TOOLS } = {}) {
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
      if (!tools.has(tc.name)) continue;
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
    // The LIFECYCLE status, separate from the conversation state above. This is
    // the moment an outcome exists, which is what "ended" means for monitoring —
    // and it makes the row immune to the expiry sweep from here on.
    await chatLinksDb.markEnded(threadId).catch((err) =>
      logger.warn("ConfirmationAgent: failed to mark chat link ended", { error: err.message, threadId })
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
async function ensureOpened({ companyId, jobId, token, companyName, companyPhone = null, representativeName = null, recipientContactId = null, linkAppointmentId = null, recipient = null }) {
  const { jobRef, customerRef, customerEmail, customerPhone } = await resolveJobRefs(companyId, jobId);
  const { recipientName, recipientEmail, recipientPhone } = await resolveRecipient(companyId, recipientContactId, customerEmail, customerPhone, recipient, token);
  const ctx = {
    companyId, jobId, threadId: token, jobRef, customerRef, companyName, companyPhone, representativeName, recipientContactId, linkAppointmentId,
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
 * Read a conversation for STAFF, without touching it.
 *
 * `graph.getState` is a pure read — it starts no node, takes no lock and writes
 * no checkpoint. Same precedent as copilot's getHistory and as ensureOpened's
 * already-opened branch above.
 *
 * Deliberately NOT ensureOpened: that marks the link opened and, on a link the
 * customer never opened, would generate the agent's opening turn — a staff
 * member glancing at the Logs page would start the conversation.
 *
 * Messages come back in exactly the shape the customer's widget receives
 * (toVisibleMessages), so one contract serves both.
 *
 * Timestamps are best-effort. The checkpointer stores no per-message time, so
 * they are borrowed from confirmation_agent_llm_logs by walking that table's
 * turns in order and matching text; anything unmatched — notably service-link
 * cards, which are tool results the log never stores — keeps created_at null.
 */
async function getConversation(companyId, token) {
  const graph = await getGraph();
  const snapshot = await graph.getState({ configurable: { thread_id: token } });
  const raw = snapshot.values?.messages || [];
  const messages = toVisibleMessages(raw);

  let turns = [];
  try {
    turns = await llmLogsDb.listTurns(companyId, token);
  } catch (err) {
    logger.warn("ConfirmationAgent: could not load turn timestamps", { error: err.message, threadId: token });
  }

  // Flatten the log into the same order the visible messages are in: each row
  // contributes its human message then its AI message, both stamped with that
  // row's time.
  const stamped = [];
  for (const t of turns) {
    if (t.human_message && t.human_message !== TRIGGER_MESSAGE) {
      stamped.push({ role: "user", content: t.human_message, at: t.created_at });
    }
    if (t.ai_message) stamped.push({ role: "agent", content: t.ai_message, at: t.created_at });
  }

  let cursor = 0;
  for (const m of messages) {
    if (m.type === "service_link") continue;   // never in the log
    const hit = stamped.findIndex((s, i) => i >= cursor && s.role === m.role && s.content === m.content);
    if (hit === -1) continue;
    m.created_at = stamped[hit].at;
    cursor = hit + 1;
  }

  return { messages, message_count: raw.length };
}

/**
 * Run one customer turn.
 *
 * @param {function|null} [onEvent] — called with `{type:"delta",chunk}` /
 *   `{type:"message",message}` as the turn unfolds. Omit it for a plain
 *   await-the-whole-turn call; the returned `messages` are the same either
 *   way, so a caller that streams must NOT also render the return value.
 */
async function sendMessage({ companyId, jobId, token, companyName, companyPhone = null, representativeName = null, content, recipientContactId = null, linkAppointmentId = null, recipient = null }, onEvent = null) {
  const { jobRef, customerRef, customerEmail, customerPhone } = await resolveJobRefs(companyId, jobId);
  const { recipientName, recipientEmail, recipientPhone } = await resolveRecipient(companyId, recipientContactId, customerEmail, customerPhone, recipient, token);
  const ctx = {
    companyId, jobId, threadId: token, jobRef, customerRef, companyName, companyPhone, representativeName, recipientContactId, linkAppointmentId,
    recipientName, recipientEmail, recipientPhone,
  };
  const messages = await runGraph(token, ctx, { messages: [new HumanMessage(content)] }, onEvent);
  return { messages };
}

/**
 * Post the CRM comment for a chat that reached an outcome and then EXPIRED.
 *
 * The normal path posts from end_conversation. A customer who confirms and then
 * abandons the chat never triggers that, so the outcome existed only in our
 * database — observed live on link 69, whose confirmed appointment never reached
 * ServiceTrade.
 *
 * Reads the checkpointer rather than querying columns, because the durable
 * per-thread stamps are inconsistent: confirm writes confirmed_by_thread_id,
 * cancel writes cancelled_by_agent_thread_id, and reschedule writes NOTHING
 * identifying the thread. summarizeOutcome covers all of them uniformly and
 * applies the same result.success check the normal path does.
 *
 * Best-effort and idempotent; never throws into the sweep.
 */
async function postExpiredOutcomeComment({ companyId, jobId, token }) {
  try {
    const graph = await getGraph();
    const snapshot = await graph.getState({ configurable: { thread_id: token } });
    const messages = snapshot.values?.messages || [];
    if (!messages.length) return { posted: false, reason: "no_conversation" };

    const { lines: summaryLines, appointmentIds } = summarizeOutcome(messages, { tools: EXPIRY_OUTCOME_TOOLS });
    if (!summaryLines.length) return { posted: false, reason: "no_outcome" };

    await postConfirmationAgentComment({
      companyId, jobId, threadId: token,
      summaryLines, appointmentIds, messageCount: messages.length,
      // Marks the comment as coming from a lapsed conversation, so the office can
      // tell it from a chat that closed properly.
      expired: true,
    });
    await chatLinksDb.markOutcomeCommentPosted(token);
    return { posted: true, outcomes: summaryLines.length };
  } catch (err) {
    logger.warn("ConfirmationAgent: expired-outcome comment failed", { error: err.message, threadId: token });
    return { posted: false, reason: "error", error: err.message };
  }
}

module.exports = {
  ensureOpened, sendMessage, getConversation, postExpiredOutcomeComment, EXPIRY_OUTCOME_TOOLS,
  // Exported for tests: the rule "a name only ever comes from a real contact"
  // is the whole point of the recipient snapshot, and it is worth pinning
  // directly rather than through a full graph run.
  resolveRecipient,
};
