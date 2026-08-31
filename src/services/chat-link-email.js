/**
 * Sends the confirmation chat-link email — the automatic, scheduler-driven
 * counterpart to the existing staff-triggered "Send chat link" action. Same
 * link (`chat_links` token, same GET/POST/reopen flow), just delivered by
 * email instead of copy/pasted by a staff member.
 *
 * Built on src/utils/email.js — the same SendGrid utility already used for
 * invite/password-reset emails, so it inherits the same no-op-if-unconfigured
 * behavior (sendMail logs and returns true when SendGrid isn't set up).
 */

const config = require("../config");
const { sendMail, buildEmailTemplate } = require("../utils/email");
const logger = require("../utils/logger");

function buildChatLinkUrl(token) {
  return `${config.frontendUrl}/chat/${encodeURIComponent(token)}`;
}

/**
 * Who to address the email to, in order of how specific — and how genuinely
 * a PERSON — each option is. `recipientName` is a real contact (a property
 * manager, etc.) — the only one of these that's an actual human; callers
 * must only pass it when it's genuinely tied to a contact record, never
 * derived from the account itself (same rule scheduler.js already applies
 * for its own dynamic variables). `siteName` (the property/location) still
 * reads naturally as an email salutation ("Hi Columbus Park Apartments,")
 * even though it isn't a person. `customerName` is the last resort before a
 * fully generic greeting, since on this platform it's often just the
 * billing account ("VareCo") rather than anyone real.
 */
function resolveGreetingName({ recipientName, siteName, customerName }) {
  return recipientName || siteName || customerName || "there";
}

/**
 * @param {object} params
 * @param {string} params.email               — recipient
 * @param {string|null} [params.recipientName] — a real contact's name, only when known
 * @param {string|null} [params.siteName]      — the property/location name
 * @param {string|null} [params.customerName]  — the billing account name (last-resort greeting)
 * @param {string} params.companyName
 * @param {string|null} [params.jobName]
 * @param {string|null} [params.serviceSummary] — short spoken service list for the next visit
 * @param {string|null} [params.scheduledLabel] — spoken date/time for the next visit
 * @param {string} params.token                — chat_links token
 * @returns {Promise<boolean>} whether the send succeeded (mirrors sendMail's return)
 */
async function sendConfirmationLinkEmail({
  email, recipientName = null, siteName = null, customerName = null, companyName,
  jobName = null, serviceSummary = null, scheduledLabel = null, token,
}) {
  const url = buildChatLinkUrl(token);
  const greetingName = resolveGreetingName({ recipientName, siteName, customerName });

  // Name the actual visit — service, site, and date — rather than a bare job
  // title/number, which tells the customer nothing about what they're being
  // asked to confirm. Falls back to the job name only when there's no next
  // appointment to describe (e.g. a job-level link with nothing booked yet).
  const visitPhrase = serviceSummary
    ? `your ${serviceSummary} visit${siteName ? ` at ${siteName}` : ""}${scheduledLabel ? ` on ${scheduledLabel}` : ""}`
    : `your upcoming appointment${jobName ? ` for ${jobName}` : ""}`;

  const subject = serviceSummary
    ? `Please confirm your upcoming ${serviceSummary} visit`
    : `Please confirm your upcoming appointment${jobName ? ` for ${jobName}` : ""}`;

  const html = buildEmailTemplate({
    userName: greetingName,
    greetingWord: "Hi",
    companyName,
    title: `Please confirm ${visitPhrase}.`,
    bodyHtml: "<p>Click the button below to chat with us and confirm — it only takes a minute.</p>",
    buttonText: "Confirm my appointment",
    buttonUrl: url,
    footerText: "If you weren't expecting this, you can safely ignore this email.",
  });

  const sent = await sendMail({
    to: email,
    subject,
    text: `Hi ${greetingName}! Please confirm ${visitPhrase} with ${companyName}. Open this link to chat with us: ${url}`,
    html,
  });

  logger.info("chat-link-email: confirmation email sent", { email, jobName, serviceSummary, sent });
  return sent;
}

module.exports = { sendConfirmationLinkEmail, buildChatLinkUrl };
