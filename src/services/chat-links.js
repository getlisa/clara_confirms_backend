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
const { buildAppointmentCards } = require("../confirmation-agent/appointment-card");
const onsiteInstructionsDb = require("../db/onsite-instructions");
const serviceLinkMessagesDb = require("../db/service-link-messages");
const { resolveSlugForCompany } = require("./crm");
const { getWorkflow } = require("../confirmation-agent/workflows");

/**
 * The job's service-link status/url for THIS conversation (service_link_messages
 * is keyed by retell_call_id, which is this token) — shape appointment-card.js's
 * builders expect. Never throws: a lookup failure just means no badge, not a
 * broken card.
 */
async function loadServiceLinkForCard(companyId, token) {
  const row = await serviceLinkMessagesDb.getByRetellCallId(companyId, token).catch(() => null);
  return { sent: row?.status === "sent", url: row?.url ?? null };
}

/**
 * What control the frontend should render for the *next* customer input,
 * derived from the link's current state. Kept as a pure function of
 * (state, context) — no I/O — so it's trivially testable.
 */
function computeInputHint(state, { jobDueDate } = {}) {
  switch (state) {
    case "chat_started":
      // "No" is dropped deliberately: on a job with several appointments it's
      // ambiguous (no to which one?), and Cancel already covers refusal.
      // Labels match the ServiceTrade workflow's required opening options
      // (confirmation-agent/workflows/servicetrade.js) — not a bare "Yes",
      // which reads oddly as a standalone button with no question attached.
      return { type: "quick_replies", options: ["Confirm", "Request Reschedule", "Cancel"] };
    case "confirmation_accepted":
      // At least one appointment is confirmed. Every upcoming appointment on
      // the job — confirmed or not — is already visible to the customer as
      // its own card, so there is no separate "confirm the rest?" quick-reply
      // step to offer here anymore; free text (or another card click) either
      // way.
      return { type: "free_text" };
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
    `SELECT c.name, c.default_timezone, c.phone_number, a.representative_name
       FROM companies c LEFT JOIN agent_settings a ON a.company_id = c.id
      WHERE c.id = $1`,
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

  // The job_confirmation hydrator's own buildJobConfirmationContext result —
  // no second fetch. Absent for other call types' hydrators (they have no
  // `context` key at all), so every read below is defensively guarded.
  const jobCtx = hydrated.context?.ok ? hydrated.context : null;
  const next = jobCtx?.appointments.next || null;

  const sent = await chatLinkEmail.sendConfirmationLinkEmail({
    email,
    // Only a genuine contact record counts as a real person to greet by
    // name — recipient_name with no recipient_contact_id is a stale/
    // unrelated snapshot field, not a person (same rule scheduler.js
    // already applies to its own dynamic variables).
    recipientName: link.recipient_contact_id != null ? (link.recipient_name || null) : null,
    siteName: jobCtx?.job.location_name || null,
    customerName: hydrated.params.customerName || null,
    companyName: company.name,
    jobName: hydrated.params.jobName || null,
    serviceSummary: next?.service_summary || null,
    scheduledLabel: next?.scheduled_start_spoken || null,
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

  // Same job_confirmation hydrator context sendConfirmationEmail already
  // reuses — no second fetch.
  const jobCtx = hydrated.context?.ok ? hydrated.context : null;
  const next = jobCtx?.appointments.next || null;

  const sent = await chatLinkSms.sendConfirmationLinkSms({
    phone,
    recipientName: link.recipient_contact_id != null ? (link.recipient_name || null) : null,
    siteName: jobCtx?.job.location_name || null,
    customerName: hydrated.params.customerName || null,
    companyName: company.name,
    jobName: hydrated.params.jobName || null,
    serviceSummary: next?.service_summary || null,
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

  const { messages, recipientName, recipientEmail, recipientPhone } = await confirmationAgent.ensureOpened({
    companyId: link.company_id, jobId: link.job_id, token, companyName: company.name, companyPhone: company.phone_number || null, representativeName: company.representative_name || null,
    recipientContactId: link.recipient_contact_id, linkAppointmentId: link.appointment_id,
    // Who the link was actually SENT to, snapshotted at dispatch (migration 095).
    recipient: { name: link.recipient_name, email: link.recipient_email, phone: link.recipient_phone },
  });

  // Re-fetch state — the opening turn's tool calls (report_customer_intent
  // etc. rarely fire on the first message, but can) may have updated it
  // since `link` was loaded.
  const fresh = await chatLinksDb.getByToken(token);

  // Fresh, not hydrated.context — the opening turn above can itself change
  // confirmation state (a tool call on the first message), so the card must
  // reflect right now, not the context captured before ensureOpened ran.
  const freshCtx = await buildJobConfirmationContext(link.company_id, link.job_id);
  const serviceLink = await loadServiceLinkForCard(link.company_id, token);
  const onsiteInstructionsAll = await onsiteInstructionsDb.listByCompany(link.company_id);

  // What this company's CRM can actually do, so the widget can shape its own
  // UI instead of guessing or hardcoding per-CRM behaviour. Bootstrap-only:
  // capabilities are a property of the connected CRM, so they cannot change
  // mid-conversation and don't need repeating on every turn.
  //
  // `cancellationReason: "optional"` is the one the frontend MUST honour —
  // routes/chat-links.js stops requiring `args.reason` on a cancel trigger for
  // those CRMs, and without this flag the widget has no way to know it can let
  // the customer skip it (see docs/inspectpoint-integration-frontend.md §4.11).
  const workflow = getWorkflow(await resolveSlugForCompany(link.company_id));

  return {
    ok: true,
    company_name: company.name,
    crm: workflow.slug,
    capabilities: {
      service_link: workflow.capabilities?.serviceLink !== false,
      slot_suggestion: workflow.capabilities?.slotSuggestion === true,
      cancellation_reason: workflow.capabilities?.cancellationReason === "optional" ? "optional" : "required",
    },
    job_name: hydrated.params.jobName || null,
    customer_name: hydrated.params.customerName || null,
    // Same resolution the prompt itself uses (recipient snapshot → nominated
    // contact → send-events fallback → customer record) — so the widget can
    // pre-fill the service-link email step (chat-cards-frontend.md §5) with a
    // real default instead of asking blind, while still letting the customer
    // edit it before anything is sent.
    contact_name: recipientName || null,
    contact_email: recipientEmail || null,
    contact_phone: recipientPhone || null,
    messages,
    state: fresh.state,
    status: fresh.status,
    input_hint: computeInputHint(fresh.state, {
      jobDueDate: hydrated.params.jobDate,
    }),
    // Full job list, same as every other card-returning call (trigger `done`
    // events already send it all) — the "one card at a time" rule is a
    // FRONTEND rendering choice, not a backend payload-size guarantee. This
    // lets the widget resolve appointment ids referenced in transcript lines
    // from an earlier session, not just the current one's `done` events.
    appointments: buildAppointmentCards(freshCtx, serviceLink, onsiteInstructionsAll),
  };
}

/**
 * Send a customer reply and get the agent's response. Returns the plain
 * (non-streamed) result — the SSE framing/typing-simulation lives in the
 * route layer, which calls this and reveals the text progressively.
 */
/**
 * @param {function|null} [onEvent] — forwarded to the agent so the caller can
 *   stream the reply as it is generated. When supplied, the returned
 *   `messages` have ALREADY been delivered through onEvent — render one or
 *   the other, never both.
 * @param {object|null} [cardTriggerArgs] — set only when `content` is a
 *   card-trigger marker (actions.js's buildCardTrigger) — see
 *   confirmationAgent.sendMessage's own doc for what this does.
 */
async function sendChatMessage(token, content, onEvent = null, cardTriggerArgs = null) {
  const link = await chatLinksDb.getByToken(token);
  if (!link) return { ok: false, status: 404, error: "Chat link not found or expired" };

  const ctx = await loadLinkContext(link);
  if (!ctx.ok) return ctx;
  const { company, hydrated } = ctx;

  const { messages } = await confirmationAgent.sendMessage({
    companyId: link.company_id, jobId: link.job_id, token, companyName: company.name, companyPhone: company.phone_number || null, representativeName: company.representative_name || null, content,
    recipientContactId: link.recipient_contact_id, linkAppointmentId: link.appointment_id,
    // Who the link was actually SENT to, snapshotted at dispatch (migration 095).
    recipient: { name: link.recipient_name, email: link.recipient_email, phone: link.recipient_phone },
  }, onEvent, cardTriggerArgs);

  // Fresh cards after this turn — a chat-driven action (the customer typed
  // instead of clicking) still refreshes the widget's cards without a
  // separate fetch. See appointment-card.js. None of these three depend on
  // each other's result, so they run concurrently rather than one at a time.
  const [fresh, freshCtx, serviceLink, onsiteInstructionsAll] = await Promise.all([
    chatLinksDb.getByToken(token),
    buildJobConfirmationContext(link.company_id, link.job_id),
    loadServiceLinkForCard(link.company_id, token),
    onsiteInstructionsDb.listByCompany(link.company_id),
  ]);
  return {
    ok: true,
    messages,
    state: fresh.state,
    status: fresh.status,
    input_hint: computeInputHint(fresh.state, {
      jobDueDate: hydrated.params.jobDate,
    }),
    appointments: buildAppointmentCards(freshCtx, serviceLink, onsiteInstructionsAll),
    // Exposed so a card-trigger route (routes/chat-links.js's
    // handleCardTriggerMessage) can build its `done` payload straight from
    // THIS already-computed freshCtx instead of paying for a second,
    // identical buildJobConfirmationContext call via its own freshCards().
    remaining_unconfirmed: freshCtx.ok ? freshCtx.counts.unconfirmed : null,
    all_confirmed: freshCtx.ok ? freshCtx.counts.all_confirmed : null,
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
