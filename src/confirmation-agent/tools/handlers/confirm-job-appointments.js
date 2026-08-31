/**
 * Batch-confirm several (or all) upcoming appointments on the current job.
 * Thin LLM-tool wrapper over actions.js's bulkConfirmCore — called from
 * free-text conversation and from a card-driven exclusive turn (POST
 * /:token/messages with trigger: "confirm_job_appointments" routes through
 * the agent for real — see actions.js's CARD_TRIGGER_PREFIX).
 *
 * `ctx.cardTriggerArgs` wins over the model's args on a card-driven turn —
 * the real values are already 100% known from the request body.
 */
const { z } = require("zod");
const { bulkConfirmCore } = require("../../actions");

const schema = z.object({
  confirm_all: z.boolean().nullish().describe("true to confirm every remaining unconfirmed upcoming appointment on this job."),
  appointment_ids: z.array(z.union([z.string(), z.number()])).nullish().describe("Specific appointment ids to confirm, if not confirming all."),
});

async function run(modelArgs, config) {
  const { companyId, jobId, threadId, recipientContactId, jobRef, recipientName, confirmedBy, cardTriggerArgs } = config?.configurable?.ctx || {};
  const { confirm_all, appointment_ids } = { ...modelArgs, ...(cardTriggerArgs || {}) };
  const result = await bulkConfirmCore({
    companyId, jobId, threadId, recipientContactId, jobRef, recipientName, confirmedBy,
    confirmAll: confirm_all === true, appointmentIds: appointment_ids || [],
  });
  return JSON.stringify(result);
}

module.exports = {
  name: "confirm_job_appointments",
  description: "Batch-confirm several or all remaining unconfirmed upcoming appointments on the current job in one call.",
  schema,
  run,
};
