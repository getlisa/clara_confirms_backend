/**
 * Move one appointment to a new time. Mirrors retell-tools.js's
 * POST /reschedule_appointment: resets customer_confirmed (a moved
 * appointment isn't confirmed at its new time), mirrors to ServiceTrade
 * best-effort, and recomputes the job's overall confirmation status.
 */
const { z } = require("zod");
const jobsDb = require("../../../db/jobs");
const stAppointments = require("../../../services/servicetrade-appointments");
const { syncJobConfirmationStatus } = require("../../../services/job-confirmation-status");
const { getCompanyTimezone, localToUTC } = require("../../../utils/timezone");
const confirmationEventsDb = require("../../../db/confirmation-events");
const logger = require("../../../utils/logger");

const schema = z.object({
  appointment_id: z.union([z.string(), z.number()]).describe("The appointment id to reschedule."),
  scheduled_start: z.string().describe("New start time, format YYYY-MM-DDTHH:MM:SS, in the customer's local time."),
  scheduled_end: z.string().nullish().describe("New end time, same format. Defaults to 2 hours after start if omitted."),
});

async function run({ appointment_id, scheduled_start, scheduled_end }, config) {
  const { companyId, threadId, recipientName } = config?.configurable?.ctx || {};
  const tz = await getCompanyTimezone(companyId);
  const startUTC = localToUTC(scheduled_start, tz);
  const endUTC = scheduled_end
    ? localToUTC(scheduled_end, tz)
    : new Date(new Date(startUTC).getTime() + 2 * 60 * 60 * 1000).toISOString();

  // Captured BEFORE the update — the ledger's "from" time, since
  // updateAppointment returns the row AFTER the write.
  const before = await jobsDb.getAppointmentById(Number(appointment_id), companyId);

  const appointment = await jobsDb.updateAppointment(Number(appointment_id), companyId, {
    scheduled_start: startUTC,
    scheduled_end: endUTC,
    customer_confirmed: false,
    customer_confirmed_at: null,
  });
  if (!appointment) return JSON.stringify({ success: false, error: "Appointment not found" });

  await stAppointments
    .mirrorRescheduleAppointment(companyId, appointment, { scheduledStart: startUTC, scheduledEnd: endUTC, retellCallId: threadId })
    .catch((err) => logger.error("ConfirmationAgent reschedule mirror failed", { error: err.message, companyId }));

  await syncJobConfirmationStatus(companyId, appointment.job_id);

  // See confirm-appointment.js for why call_type is hardcoded.
  await confirmationEventsDb.recordSafe({
    companyId, eventType: "rescheduled", channel: "chat", callType: "customer_confirmation",
    jobId: appointment.job_id, appointmentId: appointment.id,
    actorName: recipientName || null, source: threadId,
    details: { from: before?.scheduled_start ?? null, to: startUTC },
  });

  logger.info("ConfirmationAgent tool: reschedule_appointment", { companyId, appointment_id, startUTC });

  return JSON.stringify({ success: true, appointment_id: appointment.id, scheduled_start: startUTC, scheduled_end: endUTC });
}

module.exports = {
  name: "reschedule_appointment",
  description: "Move one appointment to a new date/time. Resets its confirmation — the customer is confirming a NEW time, not the old one.",
  schema,
  run,
};
