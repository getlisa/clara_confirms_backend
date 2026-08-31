/**
 * Confirm one appointment. Thin LLM-tool wrapper over
 * actions.js's confirmAppointmentCore — called both from free-text
 * conversation and from a card-driven exclusive turn (POST /:token/messages
 * with trigger: "confirm_appointment" routes through the agent for real; see
 * actions.js's CARD_TRIGGER_PREFIX), so the two invocation paths can never
 * drift on the actual write.
 *
 * `ctx.cardTriggerArgs`, when present, wins over whatever the model supplied
 * — on a card-driven turn the real appointment_id is already 100% known from
 * the request URL, so there is no reason to trust the model to relay it
 * faithfully (see graph/prompt.js's CARD_TRIGGER_PROMPT).
 */
const { z } = require("zod");
const { confirmAppointmentCore } = require("../../actions");

const schema = z.object({
  appointment_id: z.union([z.string(), z.number()]).describe("The appointment id to confirm — from the job context you were given."),
});

async function run(modelArgs, config) {
  const { companyId, threadId, recipientContactId, jobRef, recipientName, confirmedBy, cardTriggerArgs } = config?.configurable?.ctx || {};
  const { appointment_id } = { ...modelArgs, ...(cardTriggerArgs || {}) };
  const result = await confirmAppointmentCore({
    companyId, appointmentId: appointment_id, threadId, recipientContactId, jobRef, recipientName, confirmedBy,
  });
  return JSON.stringify(result);
}

module.exports = {
  name: "confirm_appointment",
  description: "Confirm the customer's attendance for one specific appointment, by its appointment_id.",
  schema,
  run,
};
