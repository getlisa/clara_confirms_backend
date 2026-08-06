/**
 * Signal a clear customer decision BEFORE the corresponding action tool
 * actually fires — mirrors retell-tools.js's POST /report_customer_intent.
 * This is what lets the frontend widget switch to a date_picker/email_form
 * ahead of the real reschedule/contact-resolution call, instead of only
 * reacting after the fact. Always offered, like end_conversation — it's
 * signaling, not a phase-gated action.
 */
const { z } = require("zod");
const chatLinksDb = require("../../../db/chat-links");
const logger = require("../../../utils/logger");

const schema = z.object({
  intent: z.enum(["wants_confirm", "wants_reschedule", "wants_cancel"]).describe(
    "The clear decision the customer just stated, before you've collected the details needed to act on it."
  ),
});

const STATE_BY_INTENT = {
  wants_confirm: "confirmation_accepted",
  wants_reschedule: "reschedule_needed",
  wants_cancel: "canceled",
};

async function run({ intent }, config) {
  const { threadId } = config?.configurable?.ctx || {};
  const state = STATE_BY_INTENT[intent];
  if (state && threadId) {
    await chatLinksDb.setStateByToken(threadId, state).catch(() => {});
  }
  logger.info("ConfirmationAgent tool: report_customer_intent", { threadId, intent });
  return JSON.stringify({ success: true });
}

module.exports = {
  name: "report_customer_intent",
  description: "Call this the moment the customer clearly states they want to confirm, reschedule, or cancel — before you've collected the details (like a new date) needed to actually do it. Lets the UI respond immediately.",
  schema,
  run,
};
