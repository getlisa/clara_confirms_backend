/**
 * ServiceTrade Service Link write-back.
 *
 * After a confirmed customer_confirmation call we email the job's ServiceTrade
 * "Service Link" to a contact. The contact is resolved (searched, or created)
 * LIVE during the call via Retell tools; the send happens POST-call.
 *
 * All ServiceTrade calls go through stLoggedRequest (payload/status/response are
 * logged). See migrations/062_service_link.sql and the plan.
 */

const { stLoggedRequest } = require("./servicetrade-api");
const serviceLinkMessagesDb = require("../db/service-link-messages");
const callSettingsDb = require("../db/call-settings");
const todosDb = require("../db/todos");
const db = require("../db");
const { sendSms } = require("../utils/sms");
const logger = require("../utils/logger");

// ── Service-link message template (SINGLE point to confirm) ─────────────────
// ServiceTrade POST /message is template-based. The exact template name + params
// for a "service link" email are configured here so there is one place to fix
// once confirmed against a captured request. Overridable via env for safety.
const SERVICE_LINK_TEMPLATE = process.env.SERVICETRADE_SERVICE_LINK_TEMPLATE || "ServiceLink";

/** Build the `params` the service-link template needs. Assumed: the job id. */
function buildServiceLinkParams(jobExternalRef) {
  return { jobId: Number(jobExternalRef) };
}

// ── Contacts ────────────────────────────────────────────────────────────────

/**
 * Search existing contacts by free text (name / phone / email).
 * @returns {Promise<Array<{id,firstName,lastName,email,phone,type,types}>>}
 */
async function searchContacts(companyId, query) {
  const res = await stLoggedRequest(
    companyId,
    "GET",
    `/contact?search=${encodeURIComponent(query)}`,
    { context: "contact.search" }
  );
  if (!res.ok) return [];
  const list = Array.isArray(res.data) ? res.data : res.data?.contacts || [];
  return list.map((c) => ({
    id: c.id, firstName: c.firstName, lastName: c.lastName,
    email: c.email, phone: c.phone, type: c.type, types: c.types,
  }));
}

let _contactTypeCache = new Map(); // companyId → Set of lowercased type names

/** Fetch (and cache) the company's available contact types. */
async function listContactTypes(companyId) {
  const res = await stLoggedRequest(companyId, "GET", "/contacttype", { context: "contacttype.list" });
  const types = res.ok ? (res.data?.contactTypes || []) : [];
  _contactTypeCache.set(String(companyId), new Set(types.map((t) => String(t).toLowerCase())));
  return types;
}

/**
 * Resolve a customer-stated role to a ServiceTrade contact type. If it matches
 * an existing type (case-insensitive) use it; otherwise create a custom type
 * (POST /contacttype) and use that. Returns the type name to tag the contact with.
 */
async function resolveContactType(companyId, role) {
  const wanted = String(role || "").trim();
  if (!wanted) return null;

  let cache = _contactTypeCache.get(String(companyId));
  if (!cache) { await listContactTypes(companyId); cache = _contactTypeCache.get(String(companyId)); }

  if (cache && cache.has(wanted.toLowerCase())) {
    return wanted.toLowerCase() === wanted ? wanted : wanted; // preserve caller casing; ST matches by name
  }

  // Not found → create a custom contact type.
  const res = await stLoggedRequest(companyId, "POST", "/contacttype", { body: { name: wanted }, context: "contacttype.create" });
  if (!res.ok) {
    logger.warn("service-link: failed to create custom contact type; contact will be created without a type", { companyId, role: wanted, status: res.status });
    return null;
  }
  const created = res.data?.name || wanted;
  // refresh cache
  if (cache) cache.add(String(created).toLowerCase());
  return created;
}

/**
 * Create a new contact tied to the customer's company (and optionally location).
 * @returns {Promise<{id, email, firstName, lastName}|null>}
 */
async function createContact(companyId, { firstName, lastName, email, phone = null, role = null, companyIds = [], locationIds = [] }) {
  const type = role ? await resolveContactType(companyId, role) : null;
  const body = {
    firstName: firstName || "",
    lastName: lastName || "",
    email: email || "",
    status: "public",
    ...(phone ? { phone } : {}),
    ...(type ? { types: [type] } : {}),
    ...(companyIds.length ? { companyIds } : {}),
    ...(locationIds.length ? { locationIds } : {}),
  };
  const res = await stLoggedRequest(companyId, "POST", "/contact", { body, context: "contact.create" });
  if (!res.ok || !res.data?.id) {
    logger.error("service-link: contact create failed", { companyId, status: res.status, messages: res.messages });
    return null;
  }
  return { id: res.data.id, email: res.data.email, firstName: res.data.firstName, lastName: res.data.lastName };
}

// ── Send ──────────────────────────────────────────────────────────────────

/**
 * Email the job's service link to a contact.
 * @returns {Promise<{ok:boolean, messageId:string|null, successCount:number, failureCount:number, status:number, messages:object}>}
 */
async function sendServiceLink(companyId, { contactId, jobExternalRef }) {
  const body = {
    contactIds: [String(contactId)],
    mode: "email",
    template: SERVICE_LINK_TEMPLATE,
    send: true,
    params: buildServiceLinkParams(jobExternalRef),
  };
  const res = await stLoggedRequest(companyId, "POST", "/message", { body, context: "message.serviceLink" });
  const data = res.data || {};
  const successCount = Number(data.successCount ?? 0);
  const failureCount = Number(data.failureCount ?? 0);
  return {
    ok: res.ok && successCount > 0 && failureCount === 0,
    messageId: data.id ?? null,
    successCount,
    failureCount,
    status: res.status,
    messages: res.messages,
  };
}

/**
 * Mint the customer-facing ServiceTrade job-summary URL for a job — the same
 * link ServiceTrade's own emailed "Service Link" template points to. Used by
 * the get_service_link tool (to display/paste the URL in a chat), the sms leg
 * of sendRecordedServiceLink below, and the appointment card's service-link
 * badge.
 *
 * `contactExternalRef` — the ServiceTrade contact id of whoever this
 * conversation is actually with — is the real, captured parameter
 * (`GET /token?jobId=&contactId=`). Falls back to the older company-level
 * `servicetrade_user_id` (`userId=`) only when no contact is resolvable (e.g.
 * nobody's been captured yet for this conversation), so a caller without a
 * contact on hand doesn't hard-fail.
 */
async function mintServiceLinkUrl(companyId, jobExternalRef, contactExternalRef = null) {
  let query;
  if (contactExternalRef) {
    query = `jobId=${encodeURIComponent(jobExternalRef)}&contactId=${encodeURIComponent(contactExternalRef)}`;
  } else {
    const { rows: credRows } = await db.query(
      `SELECT metadata->>'servicetrade_user_id' AS user_id FROM servicetrade_integration WHERE company_id = $1`,
      [companyId]
    );
    const stUserId = credRows[0]?.user_id;
    if (!stUserId) return { ok: false, error: "No contact or ServiceTrade user id available to mint a service-link token" };
    query = `jobId=${encodeURIComponent(jobExternalRef)}&userId=${encodeURIComponent(stUserId)}`;
  }

  const tokenRes = await stLoggedRequest(companyId, "GET", `/token?${query}`, { context: "serviceLink.token" });
  const token = tokenRes.data?.token || tokenRes.data?.id || (typeof tokenRes.data === "string" ? tokenRes.data : null);
  if (!tokenRes.ok || !token) {
    return { ok: false, error: "Failed to mint a service-link token", status: tokenRes.status };
  }
  return { ok: true, url: `https://app.servicetrade.com/customer/jobsummary?id=${encodeURIComponent(token)}` };
}

// ── Enablement + post-call orchestration ────────────────────────────────────

async function isServiceLinkEnabled(companyId) {
  const cs = await callSettingsDb.getByCompanyId(companyId).catch(() => null);
  return cs?.service_link_enabled === true;
}

async function raiseServiceLinkTodo(companyId, callId, retellCallId, reason, extra = {}) {
  await todosDb
    .create({
      companyId,
      callId,
      type: todosDb.TODO_TYPES.SERVICE_LINK,
      isTest: false,
      metadata: { retell_call_id: retellCallId, reason, ...extra },
    })
    .catch((err) => logger.warn("service-link: failed to raise SERVICE_LINK todo", { error: err.message, companyId }));
}

/**
 * Resolve the recorded recipient for a conversation and actually send the
 * ServiceTrade service-link email right now. Shared by:
 *  - the post-call voice flow (postCallServiceLink, below), after its own
 *    callType/outcome checks, and
 *  - the live get_service_link chat tool (src/routes/retell-tools.js), fired
 *    the instant the agent shares the link — chat has no reliable "post-call"
 *    moment to wait for (the session can stay open indefinitely), so email
 *    delivery can't be deferred the way it is for voice.
 * Best-effort — never throws. Anything not sent → status + SERVICE_LINK todo.
 * Idempotent: a row already `sent` is a no-op (e.g. the agent re-shares the
 * link later in the same chat — don't re-email every time).
 *
 * @param {object} args
 * @param {number|string} args.companyId
 * @param {string} args.retellCallId
 * @param {number|null} [args.scheduledCallId]
 * @param {number|null} [args.callId]
 */
async function sendRecordedServiceLink({ companyId, retellCallId, scheduledCallId = null, callId = null }) {
  if (!(await isServiceLinkEnabled(companyId))) {
    logger.info("service-link: service_link_enabled is FALSE for company; skipping", { companyId, retellCallId });
    return { sent: false, reason: "disabled" };
  }

  const row = await serviceLinkMessagesDb.getByRetellCallId(companyId, retellCallId);
  if (row?.status === "sent") {
    return { sent: true, reason: "already_sent", messageId: row.servicetrade_message_id ?? null };
  }

  if (!row || !row.contact_id || !row.email) {
    logger.info("service-link: no recipient captured; marking skipped + todo", { companyId, retellCallId, hasRow: !!row });
    await serviceLinkMessagesDb.markSkipped({
      companyId, scheduledCallId: scheduledCallId ?? row?.scheduled_call_id ?? null, retellCallId,
      jobExternalRef: row?.job_external_ref ?? null,
      reason: "No service-link recipient (contact/email) was captured.",
    });
    await raiseServiceLinkTodo(companyId, callId, retellCallId, "Send the customer the service link — no recipient was captured.");
    return { sent: false, reason: "no_recipient" };
  }

  if (!row.job_external_ref) {
    logger.warn("service-link: no job external_ref on the recipient row; cannot target the job", { companyId, retellCallId, rowId: row.id });
    await serviceLinkMessagesDb.markFailed(row.id, "No ServiceTrade job id to point the service link at.");
    await raiseServiceLinkTodo(companyId, callId, retellCallId, "Service link could not be sent — the job is not linked to ServiceTrade.", { contact_id: row.contact_id, email: row.email });
    return { sent: false, reason: "no_job_ref" };
  }

  // Mint the customer-facing URL once, up front — `row.contact_id` is already
  // ServiceTrade's own contact id (set by sendServiceLinkCore's contact
  // search/create, not a platform id), so no extra lookup is needed. Reused
  // for the SMS leg below AND persisted alongside the email send so the
  // appointment card can show/link to the same URL without re-minting on
  // every card fetch.
  const minted = await mintServiceLinkUrl(companyId, row.job_external_ref, row.contact_id).catch((err) => {
    logger.warn("service-link: could not mint URL", { companyId, retellCallId, error: err.message });
    return { ok: false };
  });

  // SMS leg — best-effort, independent of the email leg below. Doesn't affect
  // `status` (email via ServiceTrade's own API remains the authoritative,
  // todo-tracked channel); a phone-send failure just gets logged, never
  // raises a todo or fails the row.
  let smsSent = false;
  if (row.phone && minted.ok) {
    try {
      smsSent = await sendSms({ to: row.phone, body: `Here's your service link: ${minted.url}` });
    } catch (err) {
      logger.warn("service-link: sms leg failed", { companyId, retellCallId, error: err.message });
    }
  } else if (row.phone) {
    logger.warn("service-link: could not mint URL for sms leg", { companyId, retellCallId, error: minted.error });
  }

  try {
    const result = await sendServiceLink(companyId, { contactId: row.contact_id, jobExternalRef: row.job_external_ref });
    if (result.ok) {
      await serviceLinkMessagesDb.markSent(row.id, result.messageId, minted.ok ? minted.url : null);
      logger.info("service-link: sent OK", { companyId, retellCallId, messageId: result.messageId, contactId: row.contact_id, smsSent });
      return { sent: true, messageId: result.messageId, smsSent, url: minted.ok ? minted.url : null };
    }
    const err = JSON.stringify(result.messages || { status: result.status, failureCount: result.failureCount });
    await serviceLinkMessagesDb.markFailed(row.id, err);
    await raiseServiceLinkTodo(companyId, callId, retellCallId, "Service link email failed to send — please resend from ServiceTrade.", { contact_id: row.contact_id, email: row.email, status: result.status });
    logger.error("service-link: send failed", { companyId, retellCallId, status: result.status, messages: result.messages });
    return { sent: false, reason: "send_failed", smsSent };
  } catch (err) {
    await serviceLinkMessagesDb.markFailed(row.id, err.message);
    await raiseServiceLinkTodo(companyId, callId, retellCallId, "Service link email errored — please resend from ServiceTrade.", { contact_id: row.contact_id, email: row.email });
    logger.error("service-link: send threw", { companyId, retellCallId, error: err.message });
    return { sent: false, reason: "error" };
  }
}

/**
 * Post-call: email the job's service link for a confirmed customer_confirmation
 * call. Voice-specific gating (callType, confirmed outcome) then delegates the
 * actual resolve/send/mark logic to sendRecordedServiceLink.
 *
 * @param {object} args
 * @param {number|string} args.companyId
 * @param {object} args.scheduledCall  full scheduled_calls row
 * @param {object} args.outcome        normalized outcome (appointmentConfirmed)
 * @param {string} args.retellCallId
 * @param {number|null} [args.callId]
 */
async function postCallServiceLink({ companyId, scheduledCall, outcome, retellCallId, callId = null }) {
  const callType = scheduledCall?.call_type;
  logger.info("service-link: begin", { companyId, callType, retellCallId, appointmentConfirmed: outcome?.appointmentConfirmed });

  if (callType !== "customer_confirmation") return;
  if (outcome?.appointmentConfirmed !== "yes") {
    logger.info("service-link: appointment not confirmed; skipping", { companyId, retellCallId, appointmentConfirmed: outcome?.appointmentConfirmed });
    return;
  }

  await sendRecordedServiceLink({ companyId, retellCallId, scheduledCallId: scheduledCall?.id ?? null, callId });
}

module.exports = {
  SERVICE_LINK_TEMPLATE,
  buildServiceLinkParams,
  searchContacts,
  listContactTypes,
  resolveContactType,
  createContact,
  sendServiceLink,
  mintServiceLinkUrl,
  isServiceLinkEnabled,
  sendRecordedServiceLink,
  postCallServiceLink,
};
