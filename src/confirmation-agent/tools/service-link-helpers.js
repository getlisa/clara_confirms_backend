/**
 * Shared helpers for the two service-link tools — mirrors the private
 * helpers in retell-tools.js (isAppointmentConfirmed, maybeSendServiceLinkNow)
 * but keyed on (companyId, jobId/jobRef) directly instead of resolving them
 * from an opaque conversation id first, since this graph already has the job
 * in its own context.
 */
const db = require("../../db");
const serviceLink = require("../../services/servicetrade-service-link");
const serviceLinkMessagesDb = require("../../db/service-link-messages");
const logger = require("../../utils/logger");

async function isJobUpcomingAppointmentConfirmed(companyId, jobId) {
  const numericJobId = Number(jobId);
  if (!Number.isInteger(numericJobId) || numericJobId <= 0) return false;
  const { rows } = await db.query(
    `SELECT 1
       FROM appointments a
      WHERE a.company_id = $1 AND a.job_id = $2
        AND a.status IN ('scheduled', 'confirmed', 'rescheduled')
        AND a.scheduled_start > NOW()
        AND a.customer_confirmed = true
      LIMIT 1`,
    [companyId, numericJobId]
  );
  return rows.length > 0;
}

/**
 * Send the service link right now if the job is confirmed AND a recipient
 * has been captured — whichever becomes true LAST triggers the send, same
 * as the original tool pair. sendRecordedServiceLink is idempotent, so this
 * is safe to call from both confirm_appointment and
 * resolve_service_link_contact regardless of which order the customer does
 * things in.
 */
async function maybeSendServiceLinkNow(companyId, threadId, jobRef, jobId = null) {
  if (jobId != null) {
    const confirmed = await isJobUpcomingAppointmentConfirmed(companyId, jobId);
    if (!confirmed) return { sent: false, reason: "not_confirmed_yet" };
  }

  const row = await serviceLinkMessagesDb.getByRetellCallId(companyId, threadId);
  if (!row || !row.contact_id || !row.email) return { sent: false, reason: "no_recipient_yet" };

  return serviceLink
    .sendRecordedServiceLink({ companyId, retellCallId: threadId, scheduledCallId: null })
    .catch((err) => {
      logger.error("ConfirmationAgent maybeSendServiceLinkNow: send threw", { error: err.message, companyId, threadId });
      return { sent: false, reason: "error" };
    });
}

module.exports = { isJobUpcomingAppointmentConfirmed, maybeSendServiceLinkNow };
