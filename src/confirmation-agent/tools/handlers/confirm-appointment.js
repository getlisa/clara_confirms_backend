/**
 * Confirm one appointment. Mirrors retell-tools.js's POST /confirm_appointment
 * exactly (same jobsDb/syncJobConfirmationStatus calls) — this tool runs
 * in-process inside the graph rather than as an HTTP webhook, so there's no
 * conversationId/tool-secret indirection to resolve first.
 */
const { z } = require("zod");
const db = require("../../../db");
const jobsDb = require("../../../db/jobs");
const chatLinksDb = require("../../../db/chat-links");
const { syncJobConfirmationStatus } = require("../../../services/job-confirmation-status");
const { resolveConfirmerLabel } = require("../confirmer-label");
const logger = require("../../../utils/logger");

const schema = z.object({
  appointment_id: z.union([z.string(), z.number()]).describe("The appointment id to confirm — from the job context you were given."),
});

async function run({ appointment_id }, config) {
  const { companyId, threadId, recipientContactId } = config?.configurable?.ctx || {};

  // Don't blindly re-confirm — if this is already customer_confirmed=true
  // (confirmed earlier in this same conversation, or on a voice/SMS call
  // since this chat was opened), re-writing it would re-stamp
  // customer_confirmed_at, re-run the ServiceTrade job-status sync for no
  // reason, and (via runGraph's outcome summary) post a misleading "customer
  // confirmed" comment to ServiceTrade when nothing actually changed.
  const existing = await jobsDb.getAppointmentById(Number(appointment_id), companyId);
  if (!existing) return JSON.stringify({ success: false, error: "Appointment not found" });
  if (existing.customer_confirmed === true) {
    logger.info("ConfirmationAgent tool: confirm_appointment — already confirmed, no-op", { companyId, appointment_id });
    return JSON.stringify({ success: true, appointment_id: existing.id, already_confirmed: true });
  }

  const appointment = await jobsDb.updateAppointment(Number(appointment_id), companyId, {
    customer_confirmed: true,
  });
  if (!appointment) return JSON.stringify({ success: false, error: "Appointment not found" });

  // Record WHO confirmed — a jsonb merge (not jobsDb.updateAppointment's
  // additional_information path, which overwrites the whole column and
  // would clobber existing ServiceTrade sync metadata already stored there)
  // so a different recipient's own separate conversation about this same
  // job can later recognize it was already handled (see build.js's
  // confirmedByOtherLabel check).
  const confirmedByLabel = await resolveConfirmerLabel(companyId, recipientContactId);
  await db.query(
    `UPDATE appointments
        SET additional_information = COALESCE(additional_information, '{}'::jsonb)
              || jsonb_build_object('confirmed_by_thread_id', $1::text, 'confirmed_by_label', $2::text),
            updated_at = NOW()
      WHERE id = $3 AND company_id = $4`,
    [threadId, confirmedByLabel, appointment.id, companyId]
  );

  if (threadId) await chatLinksDb.setStateByToken(threadId, "confirmation_accepted").catch(() => {});
  const jobStatus = await syncJobConfirmationStatus(companyId, appointment.job_id);
  logger.info("ConfirmationAgent tool: confirm_appointment", { companyId, appointment_id, jobStatus });
  return JSON.stringify({ success: true, appointment_id: appointment.id, job_status: jobStatus });
}

module.exports = {
  name: "confirm_appointment",
  description: "Confirm the customer's attendance for one specific appointment, by its appointment_id.",
  schema,
  run,
};
