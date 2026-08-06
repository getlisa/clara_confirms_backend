/**
 * Resolve who a ServiceTrade "service link" should be sent to — mirrors
 * retell-tools.js's POST /resolve_service_link_contact exactly: ALWAYS
 * searches by email first (never trusts the model to self-sequence "search,
 * then only ask if not found"), and only creates a new ServiceTrade contact
 * when no match exists and the model has supplied a name.
 *
 * `threadId` (the chat_links token) plays the same role `retellCallId` plays
 * in the original tool — an opaque per-conversation key for
 * service_link_messages, unrelated to Retell.
 */
const { z } = require("zod");
const db = require("../../../db");
const serviceLink = require("../../../services/servicetrade-service-link");
const serviceLinkMessagesDb = require("../../../db/service-link-messages");
const chatLinksDb = require("../../../db/chat-links");
const { toE164 } = require("../../../utils/phone");
const logger = require("../../../utils/logger");
const { maybeSendServiceLinkNow } = require("../service-link-helpers");

const schema = z.object({
  email: z.string().describe("The email address to send the service link to."),
  first_name: z.string().nullish().describe("Only if no existing contact matched this email."),
  last_name: z.string().nullish().describe("Only if no existing contact matched this email."),
  role: z.string().nullish().describe("e.g. management, billing, on-site, scheduling, owner — only if no existing contact matched."),
  phone: z.string().nullish(),
});

async function run({ email, first_name, last_name, role, phone }, config) {
  const { companyId, jobId, threadId, jobRef, customerRef } = config?.configurable?.ctx || {};

  const candidates = await serviceLink.searchContacts(companyId, email);
  const exactMatch = candidates.find((c) => c.email && c.email.toLowerCase() === email.toLowerCase());
  const match = exactMatch || (candidates.length === 1 ? candidates[0] : null);

  let contactId, contactName, status, contactPhone;
  if (match) {
    contactId = match.id;
    contactName = [match.firstName, match.lastName].filter(Boolean).join(" ") || null;
    contactPhone = match.phone || null;
    status = "found";
  } else if (first_name || last_name) {
    const companyIds = /^\d+$/.test(String(customerRef)) ? [Number(customerRef)] : [];
    const locRaw = jobRef
      ? (await db.query(
          `SELECT payload->'location'->>'id' AS loc FROM servicetrade_jobs WHERE company_id = $1 AND servicetrade_id = $2 LIMIT 1`,
          [companyId, jobRef]
        )).rows[0]?.loc
      : null;
    const locationIds = locRaw && /^\d+$/.test(String(locRaw)) ? [Number(locRaw)] : [];
    const created = await serviceLink.createContact(companyId, {
      firstName: first_name, lastName: last_name, email, phone, role, companyIds, locationIds,
    });
    if (!created) return JSON.stringify({ success: false, error: "Failed to create contact in ServiceTrade" });
    contactId = created.id;
    contactName = [created.firstName, created.lastName].filter(Boolean).join(" ") || null;
    contactPhone = phone || null;
    status = "created";
  } else {
    if (threadId) await chatLinksDb.setStateByToken(threadId, "collecting_contact_info").catch(() => {});
    logger.info("ConfirmationAgent tool: resolve_service_link_contact — no match, more info needed", { companyId, email });
    return JSON.stringify({ success: true, status: "need_more_info", email });
  }

  const normalizedPhone = toE164(phone) || toE164(contactPhone);
  await serviceLinkMessagesDb.setRecipient({
    companyId, scheduledCallId: null, retellCallId: threadId,
    jobExternalRef: jobRef || null, contactId: String(contactId), email, phone: normalizedPhone,
  });

  const sendResult = await maybeSendServiceLinkNow(companyId, threadId, jobRef, jobId);
  logger.info("ConfirmationAgent tool: resolve_service_link_contact", { companyId, status, contactId: String(contactId), linkSent: sendResult?.sent });

  return JSON.stringify({ success: true, status, contact_id: String(contactId), name: contactName, email, link_sent: !!sendResult?.sent });
}

module.exports = {
  name: "resolve_service_link_contact",
  description: "Find (or, only if needed, create) the ServiceTrade contact to send this job's service link to. Ask only for the email first — do not ask for name/role unless this tool responds with status 'need_more_info'.",
  schema,
  run,
};
