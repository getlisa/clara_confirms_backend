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
 * @param {object} params
 * @param {string} params.email        — recipient
 * @param {string|null} params.customerName
 * @param {string} params.companyName
 * @param {string|null} params.jobName
 * @param {string} params.token        — chat_links token
 * @returns {Promise<boolean>} whether the send succeeded (mirrors sendMail's return)
 */
async function sendConfirmationLinkEmail({ email, customerName, companyName, jobName, token }) {
  const url = buildChatLinkUrl(token);
  const jobPhrase = jobName ? ` for ${jobName}` : "";

  const html = buildEmailTemplate({
    userName: customerName,
    companyName,
    title: `Please confirm your upcoming appointment${jobPhrase}.`,
    bodyHtml: "<p>Click the button below to chat with us and confirm, reschedule, or cancel — it only takes a minute.</p>",
    buttonText: "Confirm my appointment",
    buttonUrl: url,
    footerText: "If you weren't expecting this, you can safely ignore this email.",
  });

  const sent = await sendMail({
    to: email,
    subject: `Please confirm your upcoming appointment${jobPhrase}`,
    text: `Hey${customerName ? ` ${customerName}` : ""}! Please confirm your upcoming appointment${jobPhrase} with ${companyName}. Open this link to chat with us: ${url}`,
    html,
  });

  logger.info("chat-link-email: confirmation email sent", { email, jobName, sent });
  return sent;
}

module.exports = { sendConfirmationLinkEmail, buildChatLinkUrl };
