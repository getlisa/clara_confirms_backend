/**
 * Shareable chat links — a third way to reach the same conversation flow,
 * alongside voice and SMS. A staff member generates an opaque-token link for a
 * specific job or appointment; opening it (no auth — the token itself is the
 * credential) drives a stateful, guided chat conversation with our own
 * (non-Retell) UI on the other end. See chat-link-widget-frontend.md.
 *
 * The conversation itself is our own state-driven LangGraph agent
 * (src/confirmation-agent/), not Retell — see confirmationAgent.ensureOpened/
 * sendMessage below. Voice/SMS confirmations are unaffected; only this
 * chat-link surface was migrated off Retell chat.
 *
 * Reuses the same per-target hydrators call-hydration.js already built for the
 * manual-call API — same job/appointment → context resolution, no duplicate queries.
 */

const chatLinksDb = require("../db/chat-links");
const { HYDRATORS } = require("./call-hydration");
const db = require("../db");
const confirmationAgent = require("../confirmation-agent");
const chatLinkEmail = require("./chat-link-email");
const chatLinkSms = require("./chat-link-sms");
const { toE164 } = require("../utils/phone");
const { buildJobConfirmationContext } = require("./job-confirmation-context");

/**
 * What control the frontend should render for the *next* customer input,
 * derived from the link's current state. Kept as a pure function of
 * (state, context) — no I/O — so it's trivially testable.
 */
function computeInputHint(state, { jobDueDate, remainingUnconfirmed = 0 } = {}) {
  switch (state) {
    case "chat_started":
      // "No" is dropped deliberately: on a job with several appointments it's
      // ambiguous (no to which one?), and Cancel already covers refusal.
      return { type: "quick_replies", options: ["Yes", "Reschedule", "Cancel"] };
    case "confirmation_accepted":
      // At least one appointment is confirmed. If the job still has other
      // unconfirmed upcoming appointments, the agent is required to ask whether
      // to confirm those too — offer that answer as buttons.
      return remainingUnconfirmed > 0
        ? { type: "quick_replies", options: ["Yes, confirm the rest", "No, just this one"] }
        : { type: "free_text" };
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
    case "chat_ended":
      // The agent explicitly called end_conversation (or, historically, the
      // session timed out from inactivity) — there's nothing more for the
      // customer to do here. Render this as a terminal state, not a text box.
      return { type: "ended" };
    default:
      return { type: "free_text" };
  }
}

// A link is only good for one business day — after that a stale confirmation
// conversation (job maybe rescheduled/cancelled since) is worse than none.
// The unopened-chat-link watchdog (scheduler.js's processUnopenedChatLinks)
// re-queues on this same cadence, so the two stay in lockstep.
const CHAT_LINK_TTL_MS = 24 * 60 * 60 * 1000;

// recipientContactId (null = the customer themselves) — a property manager
// and the customer each get their own independent token/conversation for
// the same appointment/job, per migration 081's confirmation-recipients
// feature. Default null preserves every existing caller unchanged.
async function createChatLinkForAppointment(companyId, appointmentId, callType = "customer_confirmation", recipientContactId = null) {
  const hydrated = await HYDRATORS.scheduled_unconfirmed(companyId, appointmentId);
  if (!hydrated.ok) return hydrated;

  const existing = await chatLinksDb.findByAppointment(companyId, appointmentId, recipientContactId);
  if (existing) return { ok: true, token: existing.token };

  const row = await chatLinksDb.create({
    companyId, jobId: Number(hydrated.jobId), appointmentId, callType,
    expiresAt: new Date(Date.now() + CHAT_LINK_TTL_MS),
    recipientContactId,
  });
  return { ok: true, token: row.token };
}

/**
 * A job-scoped link's identity actually depends on THREE factors — job,
 * resolved target appointment, and recipient — not just job+recipient. So
 * this resolves "the next appointment to confirm" (same confirmed/completed
 * walk-forward logic prompt.js uses live) and delegates to the
 * appointment-scoped path, which already dedupes on exactly
 * (companyId, appointmentId, recipientContactId). Once that appointment is
 * confirmed and a different one becomes "next," this resolves to a
 * different id and a fresh token gets minted for it, rather than reusing a
 * link whose target has moved on.
 */
async function createChatLinkForJob(companyId, jobId, callType = "customer_confirmation", recipientContactId = null) {
  const ctx = await buildJobConfirmationContext(companyId, jobId);
  const nextUnconfirmed = ctx.ok ? ctx.appointments.upcoming.find((a) => !a.customer_confirmed) : null;

  if (nextUnconfirmed) {
    return createChatLinkForAppointment(companyId, nextUnconfirmed.appointment_id, callType, recipientContactId);
  }

  // Nothing upcoming/unconfirmed to anchor to (no appointment booked yet, or
  // everything already confirmed) — fall back to a job-only link.
  const hydrated = await HYDRATORS.open_job_due_soon(companyId, jobId);
  if (!hydrated.ok) return hydrated;

  const existing = await chatLinksDb.findByJob(companyId, jobId, recipientContactId);
  if (existing) return { ok: true, token: existing.token };

  const row = await chatLinksDb.create({
    companyId, jobId: Number(jobId), appointmentId: null, callType,
    expiresAt: new Date(Date.now() + CHAT_LINK_TTL_MS),
    recipientContactId,
  });
  return { ok: true, token: row.token };
}

/**
 * Resolve the hydrated job/appointment context + company/chat-agent for a
 * chat_links row. Shared by resolveChatLink and sendChatMessage.
 */
async function loadLinkContext(link) {
  const { rows: coRows } = await db.query(
    `SELECT name, default_timezone FROM companies WHERE id = $1`,
    [link.company_id]
  );
  const company = coRows[0];
  if (!company) {
    return { ok: false, status: 503, error: "Chat is not yet available for this company" };
  }

  // A confirmation conversation is job-scoped, so hydrate by JOB even when the
  // link was created from an appointment — `appointment_id` becomes payload
  // (which appointment prompted the link), exactly as it already is on
  // scheduled_calls. Other call types keep their original hydrator.
  //
  // allowNoUpcoming: this is the READ path for a link that has ALREADY been
  // delivered to a customer. Previously a link whose only appointment was
  // cancelled or had slipped into the past returned 422 here and the whole page
  // died; now it opens and the agent offers to book a new visit. Creation paths
  // (createChatLinkFor*) keep the strict check.
  const hydrated = link.call_type === "customer_confirmation"
    ? await HYDRATORS.job_confirmation(link.company_id, link.job_id, { allowNoUpcoming: true })
    : link.appointment_id
      ? await HYDRATORS.scheduled_unconfirmed(link.company_id, link.appointment_id)
      : await HYDRATORS.open_job_due_soon(link.company_id, link.job_id);
  if (!hydrated.ok) return hydrated;

  return { ok: true, company, hydrated };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Send (or re-send) a link's confirmation email — the manual, staff-triggered
 * counterpart to the scheduler's automatic web_chat dispatch
 * (src/services/scheduler.js), reusing the exact same chat-link-email.js
 * delivery. Idempotent on the link itself (same token every time); re-sends
 * the email each call, same as clicking "resend."
 *
 * @param {object} link
 * @param {string|null} [overrideEmail] — send here instead of the customer's
 *   on-file email. Same idea as a manual phone_number override on
 *   POST /calls/manual: ServiceTrade-synced customers almost never have an
 *   email on the *customer* record (it lives on a separate ServiceTrade
 *   Contact, not synced locally) — this lets staff supply one at send-time
 *   without requiring it to already be on file.
 */
async function sendConfirmationEmail(link, overrideEmail = null) {
  const ctx = await loadLinkContext(link);
  if (!ctx.ok) return ctx;
  const { company, hydrated } = ctx;

  let email = overrideEmail || null;
  if (email && !EMAIL_RE.test(email)) {
    return { ok: false, status: 400, error: "Invalid email — could not validate as an email address." };
  }
  if (!email) {
    const { rows } = await db.query(
      `SELECT c.email FROM jobs j JOIN customers c ON c.id = j.customer_id
       WHERE j.id = $1 AND j.company_id = $2`,
      [link.job_id, link.company_id]
    );
    email = rows[0]?.email || null;
  }
  if (!email) {
    return {
      ok: false, status: 422,
      error: "Customer has no email on file. Pass email to send to a specific address.",
    };
  }

  const sent = await chatLinkEmail.sendConfirmationLinkEmail({
    email,
    customerName: hydrated.params.customerName || null,
    companyName: company.name,
    jobName: hydrated.params.jobName || null,
    token: link.token,
  });

  return { ok: true, token: link.token, email, sent };
}

async function sendConfirmationEmailForAppointment(companyId, appointmentId, callType = "customer_confirmation", overrideEmail = null) {
  const created = await createChatLinkForAppointment(companyId, appointmentId, callType);
  if (!created.ok) return created;
  const link = await chatLinksDb.getByToken(created.token);
  return sendConfirmationEmail(link, overrideEmail);
}

async function sendConfirmationEmailForJob(companyId, jobId, callType = "customer_confirmation", overrideEmail = null) {
  const created = await createChatLinkForJob(companyId, jobId, callType);
  if (!created.ok) return created;
  const link = await chatLinksDb.getByToken(created.token);
  return sendConfirmationEmail(link, overrideEmail);
}

/**
 * Send (or re-send) a link's confirmation SMS — the Twilio-backed counterpart
 * to sendConfirmationEmail above. Same link, delivered by text instead of
 * email. NOT the conversational Retell "Text Now" feature — a plain text
 * with a URL.
 *
 * @param {object} link
 * @param {string|null} [overridePhone] — send here instead of the customer's
 *   on-file phone. Same idea as overrideEmail above.
 */
async function sendConfirmationSms(link, overridePhone = null) {
  const ctx = await loadLinkContext(link);
  if (!ctx.ok) return ctx;
  const { company, hydrated } = ctx;

  let phone = overridePhone ? toE164(overridePhone) : null;
  if (overridePhone && !phone) {
    return { ok: false, status: 400, error: "Invalid phone_number — could not normalize to a valid E.164 number." };
  }
  if (!phone) {
    const { rows } = await db.query(
      `SELECT c.phone FROM jobs j JOIN customers c ON c.id = j.customer_id
       WHERE j.id = $1 AND j.company_id = $2`,
      [link.job_id, link.company_id]
    );
    phone = rows[0]?.phone ? toE164(rows[0].phone) : null;
  }
  if (!phone) {
    return {
      ok: false, status: 422,
      error: "Customer has no phone on file. Pass phone to send to a specific number.",
    };
  }

  const sent = await chatLinkSms.sendConfirmationLinkSms({
    phone,
    customerName: hydrated.params.customerName || null,
    companyName: company.name,
    jobName: hydrated.params.jobName || null,
    token: link.token,
  });

  return { ok: true, token: link.token, phone, sent };
}

async function sendConfirmationSmsForAppointment(companyId, appointmentId, callType = "customer_confirmation", overridePhone = null) {
  const created = await createChatLinkForAppointment(companyId, appointmentId, callType);
  if (!created.ok) return created;
  const link = await chatLinksDb.getByToken(created.token);
  return sendConfirmationSms(link, overridePhone);
}

async function sendConfirmationSmsForJob(companyId, jobId, callType = "customer_confirmation", overridePhone = null) {
  const created = await createChatLinkForJob(companyId, jobId, callType);
  if (!created.ok) return created;
  const link = await chatLinksDb.getByToken(created.token);
  return sendConfirmationSms(link, overridePhone);
}

async function resolveChatLink(token) {
  const link = await chatLinksDb.getByToken(token);
  if (!link) {
    // Distinguish "never existed" from "existed, but the 24h link expired" —
    // very different messages for a customer clicking a stale text/email.
    const raw = await chatLinksDb.getByTokenRaw(token);
    if (raw && raw.expires_at && new Date(raw.expires_at) < new Date()) {
      return { ok: false, status: 410, code: "link_expired", error: "This confirmation link has expired." };
    }
    return { ok: false, status: 404, error: "Chat link not found" };
  }

  const ctx = await loadLinkContext(link);
  if (!ctx.ok) return ctx;
  const { company, hydrated } = ctx;

  await chatLinksDb.markOpened(link.id);

  const { messages } = await confirmationAgent.ensureOpened({
    companyId: link.company_id, jobId: link.job_id, token, companyName: company.name,
    recipientContactId: link.recipient_contact_id, linkAppointmentId: link.appointment_id,
  });

  // Re-fetch state — the opening turn's tool calls (report_customer_intent
  // etc. rarely fire on the first message, but can) may have updated it
  // since `link` was loaded.
  const fresh = await chatLinksDb.getByToken(token);

  return {
    ok: true,
    company_name: company.name,
    job_name: hydrated.params.jobName || null,
    customer_name: hydrated.params.customerName || null,
    messages,
    state: fresh.state,
    input_hint: computeInputHint(fresh.state, {
      jobDueDate: hydrated.params.jobDate,
      remainingUnconfirmed: hydrated.context?.counts.unconfirmed ?? 0,
    }),
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

  const { messages } = await confirmationAgent.sendMessage({
    companyId: link.company_id, jobId: link.job_id, token, companyName: company.name, content,
    recipientContactId: link.recipient_contact_id, linkAppointmentId: link.appointment_id,
  });

  const fresh = await chatLinksDb.getByToken(token);
  return {
    ok: true,
    messages,
    state: fresh.state,
    input_hint: computeInputHint(fresh.state, {
      jobDueDate: hydrated.params.jobDate,
      remainingUnconfirmed: hydrated.context?.counts.unconfirmed ?? 0,
    }),
  };
}

module.exports = {
  createChatLinkForAppointment,
  createChatLinkForJob,
  sendConfirmationEmailForAppointment,
  sendConfirmationEmailForJob,
  sendConfirmationSmsForAppointment,
  sendConfirmationSmsForJob,
  resolveChatLink,
  sendChatMessage,
  computeInputHint,
};
