/**
 * Cancel one appointment, or the entire job. Thin LLM-tool wrapper over
 * actions.js's cancelAppointmentCore — called from free-text conversation
 * and from a card-driven exclusive turn (POST /:token/messages with
 * trigger: "cancel_appointment" routes through the agent for real — see
 * actions.js's CARD_TRIGGER_PREFIX).
 *
 * `ctx.cardTriggerArgs` wins over the model's args on a card-driven turn —
 * the real values are already 100% known from the request body.
 */
const { z } = require("zod");
const { cancelAppointmentCore } = require("../../actions");

const schema = z.object({
  appointment_id: z.union([z.string(), z.number()]).describe("The appointment id to cancel."),
  scope: z.enum(["appointment_only", "entire_job"]).describe("Cancel just this visit, or the whole job (no other visits needed)."),
  reason: z.string().describe("Why the customer wants to cancel."),
});

async function run(modelArgs, config) {
  const { companyId, threadId, recipientName, confirmedBy, cardTriggerArgs } = config?.configurable?.ctx || {};
  const { appointment_id, scope, reason } = { ...modelArgs, ...(cardTriggerArgs || {}) };
  const result = await cancelAppointmentCore({
    companyId, appointmentId: appointment_id, threadId, recipientName, confirmedBy, scope, reason,
  });
  return JSON.stringify(result);
}

module.exports = {
  name: "cancel_appointment",
  description: "Cancel one appointment (appointment_only) or the entire job (entire_job) — always ask which, and why, before calling this.",
  schema,
  run,
};
