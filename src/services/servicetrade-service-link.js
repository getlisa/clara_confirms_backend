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
 * Post-call: email the job's service link for a confirmed customer_confirmation
 * call. Uses the `pending` recipient recorded live during the call. Best-effort —
 * never throws into the webhook path. Anything not sent → status + SERVICE_LINK todo.
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
  if (!(await isServiceLinkEnabled(companyId))) {
    logger.info("service-link: service_link_enabled is FALSE for company; skipping", { companyId, retellCallId });
    return;
  }

  const row = await serviceLinkMessagesDb.getByRetellCallId(companyId, retellCallId);
  if (!row || !row.contact_id || !row.email) {
    logger.info("service-link: confirmed but no recipient captured during the call; marking skipped + todo", { companyId, retellCallId, hasRow: !!row });
    await serviceLinkMessagesDb.markSkipped({
      companyId, scheduledCallId: scheduledCall?.id ?? null, retellCallId,
      jobExternalRef: row?.job_external_ref ?? null,
      reason: "Customer confirmed but no service-link recipient (contact/email) was captured on the call.",
    });
    await raiseServiceLinkTodo(companyId, callId, retellCallId, "Customer confirmed — send them the service link (no recipient captured on the call).");
    return;
  }

  if (!row.job_external_ref) {
    logger.warn("service-link: no job external_ref on the recipient row; cannot target the job", { companyId, retellCallId, rowId: row.id });
    await serviceLinkMessagesDb.markFailed(row.id, "No ServiceTrade job id to point the service link at.");
    await raiseServiceLinkTodo(companyId, callId, retellCallId, "Service link could not be sent — the job is not linked to ServiceTrade.", { contact_id: row.contact_id, email: row.email });
    return;
  }

  try {
    const result = await sendServiceLink(companyId, { contactId: row.contact_id, jobExternalRef: row.job_external_ref });
    if (result.ok) {
      await serviceLinkMessagesDb.markSent(row.id, result.messageId);
      logger.info("service-link: sent OK", { companyId, retellCallId, messageId: result.messageId, contactId: row.contact_id });
    } else {
      const err = JSON.stringify(result.messages || { status: result.status, failureCount: result.failureCount });
      await serviceLinkMessagesDb.markFailed(row.id, err);
      await raiseServiceLinkTodo(companyId, callId, retellCallId, "Service link email failed to send — please resend from ServiceTrade.", { contact_id: row.contact_id, email: row.email, status: result.status });
      logger.error("service-link: send failed", { companyId, retellCallId, status: result.status, messages: result.messages });
    }
  } catch (err) {
    await serviceLinkMessagesDb.markFailed(row.id, err.message);
    await raiseServiceLinkTodo(companyId, callId, retellCallId, "Service link email errored — please resend from ServiceTrade.", { contact_id: row.contact_id, email: row.email });
    logger.error("service-link: send threw", { companyId, retellCallId, error: err.message });
  }
}

module.exports = {
  SERVICE_LINK_TEMPLATE,
  buildServiceLinkParams,
  searchContacts,
  listContactTypes,
  resolveContactType,
  createContact,
  sendServiceLink,
  isServiceLinkEnabled,
  postCallServiceLink,
};
