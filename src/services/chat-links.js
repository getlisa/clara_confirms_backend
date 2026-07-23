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
 * start_speaker:"agent", which only drives voice). Calling
 * createChatCompletion({ chat_id, content: "" }) correctly triggers the
 * flow's opening message with no fake user turn in the transcript — that's
 * the mechanism getOrCreateSession relies on below.
 */

const chatLinksDb = require("../db/chat-links");
const { HYDRATORS } = require("./call-hydration");
const db = require("../db");
const retell = require("./retell");
const { formatSpokenDateTime, formatSpokenDateOnly } = require("../utils/timezone");

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

/** Keep only real chat turns — strip node_transition/tool_call_* plumbing. */
function filterVisibleMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m) => m.role === "agent" || m.role === "user")
    .map((m) => ({ role: m.role, content: m.content, created_at: m.created_timestamp ?? null }));
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
 * Ensure a real Retell chat session exists for this link, creating it (and
 * triggering the opening message) on first open, or resuming it otherwise.
 * Race-safe: two near-simultaneous first-opens only leave one live session.
 * @returns {Promise<{chatId:string, messages:Array}>}
 */
async function getOrCreateSession(link, dynamicVariables, chatAgentId) {
  const client = retell.getClient();

  if (link.retell_chat_id) {
    const chat = await client.chat.retrieve(link.retell_chat_id);
    return { chatId: link.retell_chat_id, messages: filterVisibleMessages(chat.message_with_tool_calls) };
  }

  const created = await client.chat.create({
    agent_id: chatAgentId,
    retell_llm_dynamic_variables: dynamicVariables,
    metadata: { company_id: String(link.company_id), call_type: link.call_type, channel: "web_chat" },
  });

  const claimed = await chatLinksDb.claimRetellChatId(link.id, created.chat_id);
  if (!claimed) {
    // Another concurrent request already won the race — discard our
    // just-created (now orphaned) session and adopt the winner's.
    await client.chat.end(created.chat_id).catch(() => {});
    const winner = await chatLinksDb.getByToken(link.token);
    const chat = await client.chat.retrieve(winner.retell_chat_id);
    return { chatId: winner.retell_chat_id, messages: filterVisibleMessages(chat.message_with_tool_calls) };
  }

  // Trigger the opening message — empty content, no fake user turn appears.
  const completion = await client.chat.createChatCompletion({ chat_id: created.chat_id, content: "" });
  return { chatId: created.chat_id, messages: filterVisibleMessages(completion.messages) };
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

  // Defensive — ensures a session exists even if a message somehow arrives
  // before the first GET (getOrCreateSession no-ops into a resume otherwise).
  let chatId = link.retell_chat_id;
  if (!chatId) {
    const session = await getOrCreateSession(link, dynamicVariables, company.retell_chat_agent_id);
    chatId = session.chatId;
  }

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
