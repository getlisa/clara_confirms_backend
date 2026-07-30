/**
 * Sends the confirmation chat-link SMS — the Twilio-backed counterpart to
 * chat-link-email.js. Same link (`chat_links` token, same GET/POST/reopen
 * flow), delivered by text instead of email — a plain text with a URL, NOT
 * a live Retell agent<->customer conversation. Used both by the "web_chat"
 * channel's sms delivery method and by the plain "sms" channel (which used
 * to start a live Retell conversation via createSmsChat — that's disabled
 * for now in favor of this link-based send; see scheduler.js).
 *
 * Built on src/utils/sms.js — inherits the same no-op-if-unconfigured
 * behavior (sendSms logs and returns true when Twilio isn't set up).
 */

const { sendSms } = require("../utils/sms");
const { buildChatLinkUrl } = require("./chat-link-email");
const logger = require("../utils/logger");

/**
 * @param {object} params
 * @param {string} params.phone        — recipient, E.164
 * @param {string|null} params.customerName
 * @param {string} params.companyName
 * @param {string|null} params.jobName
 * @param {string} params.token        — chat_links token
 * @returns {Promise<boolean>} whether the send succeeded (mirrors sendSms's return)
 */
async function sendConfirmationLinkSms({ phone, customerName, companyName, jobName, token }) {
  const url = buildChatLinkUrl(token);
  const jobPhrase = jobName ? ` for ${jobName}` : "";
  const greeting = customerName ? `Hi ${customerName}, ` : "Hi, ";

  const body = `${greeting}please confirm your upcoming appointment${jobPhrase} with ${companyName}. Chat with us here: ${url}`;
  console.log("=======> body:", body);

  const sent = await sendSms({ to: phone, body });

  logger.info("chat-link-sms: confirmation sms sent", { jobName, sent });
  return sent;
}

module.exports = { sendConfirmationLinkSms };
