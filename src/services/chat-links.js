/**
 * Shareable chat links — a third way to reach the same conversation flow,
 * alongside voice and SMS. A staff member generates an opaque-token link for a
 * specific job or appointment; opening it (no auth — the token itself is the
 * credential) drives a stateful, guided chat conversation with our own
 * (non-Retell) UI on the other end. See chat-link-widget-frontend.md.
 *
 * Reuses the same per-target hydrators call-hydration.js already built for the
 * manual-call API — same job/appointment → context resolution, no duplicate queries.
 *
 * The agent must always speak first: client.chat.create() alone does NOT
 * auto-send an opening message (verified live — a session sits empty until
 * something triggers a turn, even though the shared flow has
 * start_speaker:"agent", which only drives voice). Triggering with an EMPTY
 * content string does correctly produce a first agent turn — but empirically,
 * on that context-free first turn, the model does not reliably evaluate the
 * prompt's {{is_chat_session}} conditional and can default to the voice-phrased
 * opening. A short, real (filtered-out) trigger message that explicitly states
 * this is a chat session is far more reliable — the model is reacting to an
 * actual instruction instead of nothing — hence CHAT_TRIGGER_MESSAGE below
 * instead of an empty string.
 */

const chatLinksDb = require("../db/chat-links");
const { HYDRATORS } = require("./call-hydration");
const db = require("../db");
const retell = require("./retell");
const { formatSpokenDateTime, formatSpokenDateOnly } = require("../utils/timezone");

// Sent as the synthetic first "user" turn to reliably trigger the agent's
// opening message in the right (chat) register — filtered out of everything
// returned to the frontend by filterVisibleMessages, so the customer never sees it.
const CHAT_TRIGGER_MESSAGE = "(This is a text chat, not a phone call. Please begin now with your chat-appropriate opening message.)";

function buildDynamicVariables(params, { callType, isAppointment, tz }) {
  return {
    call_type: callType,
    is_chat_session: "true",
    ...(params.customerName && { customer_name: params.customerName }),
    ...(params.customerAddress && { customer_address: params.customerAddress }),
    ...(params.jobName && { job_name: params.jobName }),
    ...(params.jobDescription && { job_description: params.jobDescription }),
    ...(params.jobType && { job_type: params.jobType }),
    ...(params.jobDate && {
      job_date: isAppointment
        ? formatSpokenDateTime(new Date(params.jobDate).toISOString(), tz)
        : formatSpokenDateOnly(params.jobDate),
    }),
    ...(params.appointmentId && { appointment_id: String(params.appointmentId) }),
    job_id: String(params.jobId),
  };
}

/**
 * Keep only real chat turns — strip node_transition/tool_call_* plumbing and
 * the synthetic trigger — but surface a successful get_service_link call as a
 * structured `type: "service_link"` entry (url + job_name) instead of just
 * whatever text the agent said, so the frontend can render a preview card
 * (rather than parsing a raw URL out of message text) and only navigate to
 * the full ServiceTrade page on click.
 */
function filterVisibleMessages(messages) {
  if (!Array.isArray(messages)) return [];

  const invocationNameById = {};
  for (const m of messages) {
    if (m.role === "tool_call_invocation") invocationNameById[m.tool_call_id] = m.name;
  }

  const out = [];
  for (const m of messages) {
    if ((m.role === "agent" || m.role === "user") && m.content !== CHAT_TRIGGER_MESSAGE) {
      out.push({ role: m.role, content: m.content, created_at: m.created_timestamp ?? null });
      continue;
    }
    if (m.role === "tool_call_result" && invocationNameById[m.tool_call_id] === "get_service_link") {
      let parsed;
      try { parsed = JSON.parse(m.content); } catch { parsed = null; }
      if (parsed?.success && parsed?.url) {
        out.push({
          role: "agent",
          type: "service_link",
          url: parsed.url,
          job_name: parsed.job_name ?? null,
          created_at: m.created_timestamp ?? null,
        });
      }
    }
  }
  return out;
}

/**
 * What control the frontend should render for the *next* customer input,
 * derived from the link's current state. Kept as a pure function of
 * (state, context) — no I/O — so it's trivially testable.
 */
function computeInputHint(state, { jobDueDate } = {}) {
  switch (state) {
    case "chat_started":
      return { type: "quick_replies", options: ["Yes", "No", "Reschedule", "Cancel"] };
    case "reschedule_needed":
      return {
        type: "date_picker",
        min: new Date().toISOString().slice(0, 10),
        max: jobDueDate ? new Date(jobDueDate).toISOString().slice(0, 10) : null,
      };
    case "collecting_contact_info":
      // Simplification: we don't have a live "found vs not found" signal at
      // this layer (that's inside the agent's own tool-call judgment) — default
      // to the simpler email-only form; a contact_form variant (name/email/phone)
      // is a documented follow-on, not built this pass.
      return { type: "email_form" };
    default:
      return { type: "free_text" };
  }
}

async function createChatLinkForAppointment(companyId, appointmentId, callType = "customer_confirmation") {
  const hydrated = await HYDRATORS.scheduled_unconfirmed(companyId, appointmentId);
  if (!hydrated.ok) return hydrated;

  const existing = await chatLinksDb.findByAppointment(companyId, appointmentId);
  if (existing) return { ok: true, token: existing.token };

  const row = await chatLinksDb.create({
    companyId, jobId: Number(hydrated.jobId), appointmentId, callType,
  });
  return { ok: true, token: row.token };
}

async function createChatLinkForJob(companyId, jobId, callType = "customer_confirmation") {
  const hydrated = await HYDRATORS.open_job_due_soon(companyId, jobId);
  if (!hydrated.ok) return hydrated;

  const existing = await chatLinksDb.findByJob(companyId, jobId);
  if (existing) return { ok: true, token: existing.token };

  const row = await chatLinksDb.create({
    companyId, jobId: Number(jobId), appointmentId: null, callType,
  });
  return { ok: true, token: row.token };
}

/**
 * Resolve the hydrated job/appointment context + company/chat-agent for a
 * chat_links row. Shared by resolveChatLink and sendChatMessage.
 */
async function loadLinkContext(link) {
  const { rows: coRows } = await db.query(
    `SELECT retell_chat_agent_id, name, default_timezone FROM companies WHERE id = $1`,
    [link.company_id]
  );
  const company = coRows[0];
  if (!company?.retell_chat_agent_id) {
    return { ok: false, status: 503, error: "Chat is not yet available for this company" };
  }

  const hydrated = link.appointment_id
    ? await HYDRATORS.scheduled_unconfirmed(link.company_id, link.appointment_id)
    : await HYDRATORS.open_job_due_soon(link.company_id, link.job_id);
  if (!hydrated.ok) return hydrated;

  return { ok: true, company, hydrated };
}

/**
 * Create a brand-new Retell chat session for this link and trigger its
 * opening message. Shared by first-open and reopen-after-expiry — the only
 * difference is how the winning chat_id gets written back (claim onto a null
 * column vs. compare-and-swap off a known-dead one), so `persist` supplies
 * that one call and this does the create/race/trigger mechanics once.
 */
async function createAndTriggerSession(link, dynamicVariables, chatAgentId, persist) {
  const client = retell.getClient();

  const created = await client.chat.create({
    agent_id: chatAgentId,
    retell_llm_dynamic_variables: dynamicVariables,
    metadata: { company_id: String(link.company_id), call_type: link.call_type, channel: "web_chat" },
  });

  const claimed = await persist(created.chat_id);
  if (!claimed) {
    // Another concurrent request already won the race — discard our
    // just-created (now orphaned) session and adopt the winner's.
    await client.chat.end(created.chat_id).catch(() => {});
    const winner = await chatLinksDb.getByToken(link.token);
    const chat = await client.chat.retrieve(winner.retell_chat_id);
    return { chatId: winner.retell_chat_id, messages: filterVisibleMessages(chat.message_with_tool_calls) };
  }

  // Trigger the opening message — synthetic content, no fake user turn appears.
  const completion = await client.chat.createChatCompletion({ chat_id: created.chat_id, content: CHAT_TRIGGER_MESSAGE });
  return { chatId: created.chat_id, messages: filterVisibleMessages(completion.messages) };
}

/**
 * Ensure a real, LIVE Retell chat session exists for this link — creating one
 * (and triggering the opening message) on first open, resuming it if it's
 * still active, or transparently reopening with a fresh session if the prior
 * one can no longer generate new turns.
 *
 * Retell auto-closes a chat after a period of silence (end_chat_after_silence_ms
 * on the chat agent); once chat_status is "ended" (or "error"), createChatCompletion
 * on that chat_id no longer works. A customer coming back to an old link after
 * that point needs a fresh session, not a resume — but they should still see
 * their prior conversation above the new turn, so we prepend it rather than
 * discarding it. State resets to chat_started for the new session; the agent's
 * own get_job/get_appointment tool calls will naturally reflect whatever the
 * platform's real, current state is (e.g. already confirmed) regardless of
 * what chat_links.state says, same as any voice/SMS callback would.
 *
 * Race-safe in both directions: two near-simultaneous first-opens, or two
 * near-simultaneous reopens of the same dead session, only leave one live
 * session behind.
 * @returns {Promise<{chatId:string, messages:Array}>}
 */
async function getOrCreateSession(link, dynamicVariables, chatAgentId) {
  const client = retell.getClient();

  if (link.retell_chat_id) {
    const chat = await client.chat.retrieve(link.retell_chat_id);
    if (chat.chat_status === "ended" || chat.chat_status === "error") {
      const priorMessages = filterVisibleMessages(chat.message_with_tool_calls);
      const reopened = await createAndTriggerSession(link, dynamicVariables, chatAgentId, (newChatId) =>
        chatLinksDb.reopen(link.id, link.retell_chat_id, newChatId)
      );
      return { chatId: reopened.chatId, messages: [...priorMessages, ...reopened.messages] };
    }
    return { chatId: link.retell_chat_id, messages: filterVisibleMessages(chat.message_with_tool_calls) };
  }

  return createAndTriggerSession(link, dynamicVariables, chatAgentId, (newChatId) =>
    chatLinksDb.claimRetellChatId(link.id, newChatId)
  );
}

async function resolveChatLink(token) {
  const link = await chatLinksDb.getByToken(token);
  if (!link) return { ok: false, status: 404, error: "Chat link not found or expired" };

  const ctx = await loadLinkContext(link);
  if (!ctx.ok) return ctx;
  const { company, hydrated } = ctx;

  await chatLinksDb.markOpened(link.id);

  const tz = company.default_timezone || "America/New_York";
  const dynamicVariables = buildDynamicVariables(hydrated.params, {
    callType: link.call_type,
    isAppointment: !!link.appointment_id,
    tz,
  });

  const { messages } = await getOrCreateSession(link, dynamicVariables, company.retell_chat_agent_id);

  // Re-fetch state — getOrCreateSession's tool calls (e.g. the opening
  // message rarely triggers one, but a resumed session's earlier turns may
  // have) can have updated it since `link` was loaded.
  const fresh = await chatLinksDb.getByToken(token);

  return {
    ok: true,
    company_name: company.name,
    job_name: hydrated.params.jobName || null,
    customer_name: hydrated.params.customerName || null,
    messages,
    state: fresh.state,
    input_hint: computeInputHint(fresh.state, { jobDueDate: hydrated.params.jobDate }),
  };
}

/**
 * Send a customer reply and get the agent's response. Returns the plain
 * (non-streamed) result — the SSE framing/typing-simulation lives in the
 * route layer, which calls this and reveals the text progressively.
 */
async function sendChatMessage(token, content) {
  const link = await chatLinksDb.getByToken(token);
  if (!link) return { ok: false, status: 404, error: "Chat link not found or expired" };

  const ctx = await loadLinkContext(link);
  if (!ctx.ok) return ctx;
  const { company, hydrated } = ctx;

  const tz = company.default_timezone || "America/New_York";
  const dynamicVariables = buildDynamicVariables(hydrated.params, {
    callType: link.call_type,
    isAppointment: !!link.appointment_id,
    tz,
  });

  // Always routed through getOrCreateSession (not just when no chat_id exists
  // yet) so a message sent against an already-expired session (e.g. the page
  // was left open past the inactivity timeout without a fresh GET) still gets
  // transparently reopened instead of erroring against a dead chat_id.
  const session = await getOrCreateSession(link, dynamicVariables, company.retell_chat_agent_id);
  const chatId = session.chatId;

  const client = retell.getClient();
  const completion = await client.chat.createChatCompletion({ chat_id: chatId, content });
  const messages = filterVisibleMessages(completion.messages);

  const fresh = await chatLinksDb.getByToken(token);
  return {
    ok: true,
    messages,
    state: fresh.state,
    input_hint: computeInputHint(fresh.state, { jobDueDate: hydrated.params.jobDate }),
  };
}

module.exports = {
  createChatLinkForAppointment,
  createChatLinkForJob,
  resolveChatLink,
  sendChatMessage,
  filterVisibleMessages,
  computeInputHint,
};
