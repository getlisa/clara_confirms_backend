/**
 * Record who is actually confirming for this chat session — first name,
 * last name, role, and a phone number (email optional). Thin LLM-tool
 * wrapper over actions.js's captureConfirmerIdentityCore — called either by
 * the model during natural free-text conversation, or directly by the
 * frontend's own identity-sheet UI as a card-driven exclusive turn (POST
 * /:token/messages with trigger: "capture_confirmer_identity" — see
 * routes/chat-links.js's CARD_TRIGGER_TOOLS). Same handler, same DB write,
 * either way.
 *
 * `ctx.cardTriggerArgs` wins over the model's args on a card-driven turn —
 * the real values are already 100% known from the request body.
 *
 * Reused afterward via ctx.confirmedBy (confirmation-agent/index.js's
 * resolveConfirmedBy, threaded the same way ctx.recipientName is) — no
 * handler needs to ask again once this has run for the session.
 */
const { z } = require("zod");
const { captureConfirmerIdentityCore } = require("../../actions");

const schema = z.object({
  first_name: z.string().describe("The confirmer's first name."),
  last_name: z.string().describe("The confirmer's last name."),
  role: z.enum(["management", "on_site", "billing", "scheduling", "owner", "other"])
    .describe("The confirmer's role at the property/account."),
  phone: z.string().describe("The confirmer's phone number."),
  email: z.string().nullish().describe("The confirmer's email, if given."),
});

async function run(modelArgs, config) {
  const { threadId, cardTriggerArgs } = config?.configurable?.ctx || {};
  const args = { ...modelArgs, ...(cardTriggerArgs || {}) };
  const result = await captureConfirmerIdentityCore({
    threadId,
    firstName: args.first_name,
    lastName: args.last_name,
    role: args.role,
    phone: args.phone,
    email: args.email ?? null,
  });
  return JSON.stringify(result);
}

module.exports = {
  name: "capture_confirmer_identity",
  description: "Record who is actually confirming this job — first name, last name, role, and a phone number (email optional). Call this once, early in the conversation, before completing the first confirm/reschedule/cancel/create action — never again once WHO YOU'RE TALKING TO already shows a captured identity.",
  schema,
  run,
};
