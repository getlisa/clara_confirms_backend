/**
 * Book a new appointment on a job that has none upcoming. Mirrors
 * retell-tools.js's POST /create_appointment: promotes an 'open' job to
 * 'scheduled', mirrors to ServiceTrade best-effort.
 */
const { z } = require("zod");
const db = require("../../../db");
const jobsDb = require("../../../db/jobs");
const stAppointments = require("../../../services/servicetrade-appointments");
const { syncJobConfirmationStatus } = require("../../../services/job-confirmation-status");
const { getCompanyTimezone, localToUTC } = require("../../../utils/timezone");
const confirmationEventsDb = require("../../../db/confirmation-events");
const logger = require("../../../utils/logger");

const schema = z.object({
  scheduled_start: z.string().describe("Preferred start time, format YYYY-MM-DDTHH:MM:SS, in the customer's local time."),
  scheduled_end: z.string().nullish().describe("Preferred end time, same format. Defaults to 2 hours after start."),
});

async function run({ scheduled_start, scheduled_end }, config) {
  const { companyId, jobId, threadId, recipientName } = config?.configurable?.ctx || {};
  const tz = await getCompanyTimezone(companyId);
  const startUTC = localToUTC(scheduled_start, tz);
  const endUTC = scheduled_end
    ? localToUTC(scheduled_end, tz)
    : new Date(new Date(startUTC).getTime() + 2 * 60 * 60 * 1000).toISOString();

  const appointment = await jobsDb.createAppointment(companyId, Number(jobId), {
    scheduled_start: startUTC,
    scheduled_end: endUTC,
  });

  await db.query(
    `UPDATE jobs SET status = 'scheduled', updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status = 'open'`,
    [jobId, companyId]
  );
  await syncJobConfirmationStatus(companyId, Number(jobId));

  await stAppointments
    .mirrorCreateAppointment(companyId, appointment, Number(jobId), { scheduledStart: startUTC, scheduledEnd: endUTC, retellCallId: threadId })
    .catch((err) => logger.error("ConfirmationAgent create_appointment mirror failed", { error: err.message, companyId }));

  // See confirm-appointment.js for why call_type is hardcoded.
  await confirmationEventsDb.recordSafe({
    companyId, eventType: "created", channel: "chat", callType: "customer_confirmation",
    jobId: Number(jobId), appointmentId: appointment.id,
    actorName: recipientName || null, source: threadId,
    details: { scheduled_start: startUTC },
  });

  logger.info("ConfirmationAgent tool: create_appointment", { companyId, jobId, startUTC });
  return JSON.stringify({ success: true, appointment_id: appointment.id, scheduled_start: startUTC, scheduled_end: endUTC });
}

module.exports = {
  name: "create_appointment",
  description: "Book a new appointment on this job when there is no upcoming visit scheduled yet.",
  schema,
  run,
};
