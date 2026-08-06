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
    // `status` here is Twilio's IMMEDIATE queueing status ("queued"/"accepted"/
    // "sending"/"sent") — NOT final delivery. Twilio delivers the real
    // delivered/undelivered verdict asynchronously (carrier DLR), which we
    // don't currently receive (no statusCallback configured) — check the
    // Twilio console/API for a message's final status by its `sid`.
    logger.info("SMS sent", {
      to: to?.slice(0, 4) + "***",
      sid: message.sid,
      status: message.status,
      errorCode: message.errorCode,
      errorMessage: message.errorMessage,
      numSegments: message.numSegments,
    });
    return true;
  } catch (err) {
    // Twilio's synchronous rejection shape (e.g. invalid/unreachable number,
    // account/permission errors) — code/moreInfo point at the specific
    // Twilio error (see twilio.com/docs/errors/<code>).
    logger.error("Twilio error", {
      error: err.message,
      to: to?.slice(0, 4) + "***",
      code: err.code,
      status: err.status,
      moreInfo: err.moreInfo,
    });
    throw err;
  }
}

module.exports = { sendSms, init };
