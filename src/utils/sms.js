/**
 * Send SMS via Twilio.
 * Uses config.twilio (accountSid, authToken, fromNumber).
 */

const twilio = require("twilio");
const config = require("../config");
const logger = require("./logger");

let client = null;
let initialized = false;

function init() {
  if (initialized) return !!client;
  if (!config.twilio.accountSid || !config.twilio.authToken || !config.twilio.fromNumber) {
    logger.warn("Twilio not configured (missing accountSid/authToken/fromNumber)");
    initialized = true;
    return false;
  }
  client = twilio(config.twilio.accountSid, config.twilio.authToken);
  initialized = true;
  return true;
}

/**
 * Send a single SMS.
 * @param {Object} opts - { to, body }
 * @returns {Promise<boolean>}
 */
async function sendSms({ to, body }) {
  if (!init()) {
    logger.info("SMS skipped (Twilio not configured)", { to: to?.slice(0, 4) + "***" });
    return true;
  }
  try {
    const message = await client.messages.create({
      to,
      from: config.twilio.fromNumber,
      body,
    });
    logger.info("SMS sent", { to: to?.slice(0, 4) + "***", sid: message.sid });
    return true;
  } catch (err) {
    logger.error("Twilio error", { error: err.message, to: to?.slice(0, 4) + "***" });
    throw err;
  }
}

module.exports = { sendSms, init };
