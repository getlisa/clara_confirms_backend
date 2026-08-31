/**
 * Move one appointment to a new time. Thin LLM-tool wrapper over
 * actions.js's rescheduleAppointmentCore — called from free-text
 * conversation and from a card-driven exclusive turn (POST /:token/messages
 * with trigger: "reschedule_appointment" routes through the agent for real —
 * see actions.js's CARD_TRIGGER_PREFIX).
 *
 * `scheduled_start` is OPTIONAL: when the customer declined to pick a new
 * time, there is no time to reschedule to, so this branches internally to
 * actions.js's raiseRescheduleRequest (a todo-only staff escalation, no
 * appointment write) instead of rescheduleAppointmentCore. Both branches are
 * the SAME tool/trigger — chat-cards-frontend.md §3 documents
 * `tool_result.result` as two possible shapes depending on which ran.
 *
 * `ctx.cardTriggerArgs` wins over the model's args on a card-driven turn —
 * the real values are already 100% known from the request body. UNLIKE the
 * other four promoted handlers, this does not merge cardTriggerArgs OVER
 * modelArgs for scheduled_start/scheduled_end — it uses cardTriggerArgs'
 * OWN value for those two fields outright (`undefined` included) once a
 * card trigger is in progress. The skip path relies on scheduled_start
 * being ABSENT; the usual `{...modelArgs, ...cardTriggerArgs}` merge only
 * overrides keys cardTriggerArgs actually sets, so a model that added a
 * plausible-looking (hallucinated) date despite the request never asking
 * for one would otherwise silently turn a "customer declined to pick a
 * time" click into a real reschedule.
 */
const { z } = require("zod");
const { rescheduleAppointmentCore, raiseRescheduleRequest } = require("../../actions");

const schema = z.object({
  appointment_id: z.union([z.string(), z.number()]).describe("The appointment id to reschedule."),
  scheduled_start: z.string().nullish().describe("New start time, format YYYY-MM-DDTHH:MM:SS, in the customer's local time. Omit ONLY when the customer wants to reschedule but won't give a specific time — this raises a staff follow-up instead of moving the appointment."),
  scheduled_end: z.string().nullish().describe("New end time, same format. Defaults to 2 hours after start if omitted."),
});

async function run(modelArgs, config) {
  const { companyId, jobId, threadId, recipientName, confirmedBy, cardTriggerArgs } = config?.configurable?.ctx || {};
  const appointment_id = cardTriggerArgs ? cardTriggerArgs.appointment_id : modelArgs.appointment_id;
  const scheduled_start = cardTriggerArgs ? cardTriggerArgs.scheduled_start : modelArgs.scheduled_start;
  const scheduled_end = cardTriggerArgs ? cardTriggerArgs.scheduled_end : modelArgs.scheduled_end;

  if (!scheduled_start) {
    const result = await raiseRescheduleRequest({ companyId, jobId, appointmentId: appointment_id, threadId });
    return JSON.stringify({ ...result, appointment_id, message: "Our team will follow up to find a time." });
  }

  const result = await rescheduleAppointmentCore({
    companyId, appointmentId: appointment_id, threadId, recipientName, confirmedBy,
    scheduledStart: scheduled_start, scheduledEnd: scheduled_end,
  });
  return JSON.stringify(result);
}

module.exports = {
  name: "reschedule_appointment",
  description: "Move one appointment to a new date/time. Resets its confirmation — the customer is confirming a NEW time, not the old one. Call with no scheduled_start if the customer wants to reschedule but won't commit to a time — this raises a staff follow-up instead, and does not change the appointment.",
  schema,
  run,
};
