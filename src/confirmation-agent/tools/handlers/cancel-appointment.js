/**
 * Cancel one appointment, or the entire job. Mirrors retell-tools.js's
 * POST /cancel_appointment: platform write first (source of truth), then
 * best-effort ServiceTrade mirror, plus a low-priority FYI todo so staff
 * know a cancellation happened without it needing escalation.
 */
const { z } = require("zod");
const db = require("../../../db");
const jobsDb = require("../../../db/jobs");
const chatLinksDb = require("../../../db/chat-links");
const stAppointments = require("../../../services/servicetrade-appointments");
const todosDb = require("../../../db/todos");
const { syncJobConfirmationStatus } = require("../../../services/job-confirmation-status");
const logger = require("../../../utils/logger");

const schema = z.object({
  appointment_id: z.union([z.string(), z.number()]).describe("The appointment id to cancel."),
  scope: z.enum(["appointment_only", "entire_job"]).describe("Cancel just this visit, or the whole job (no other visits needed)."),
  reason: z.string().describe("Why the customer wants to cancel."),
});

async function run({ appointment_id, scope, reason }, config) {
  const { companyId, threadId } = config?.configurable?.ctx || {};

  const existing = await jobsDb.getAppointmentById(Number(appointment_id), companyId);
  if (!existing) return JSON.stringify({ success: false, error: "Appointment not found" });

  const appointment = await jobsDb.updateAppointment(Number(appointment_id), companyId, {
    status: "cancelled",
    cancellation_reason: reason,
  });
  await db.query(
    `UPDATE appointments
        SET additional_information = COALESCE(additional_information, '{}'::jsonb)
              || jsonb_build_object('cancelled_by_agent_thread_id', $1::text, 'cancellation_scope', $2::text),
            updated_at = NOW()
      WHERE id = $3 AND company_id = $4`,
    [threadId, scope, appointment.id, companyId]
  );

  let job = null;
  if (scope === "entire_job") {
    job = await jobsDb.updateJob(existing.job_id, companyId, { status: "cancelled" });
  } else {
    await syncJobConfirmationStatus(companyId, existing.job_id);
  }

  await stAppointments
    .mirrorCancelAppointment(companyId, appointment, { retellCallId: threadId })
    .catch((err) => logger.error("ConfirmationAgent cancel mirror failed", { error: err.message, companyId }));
  if (scope === "entire_job") {
    const { rows: jobRows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [existing.job_id, companyId]);
    await stAppointments
      .mirrorCancelJob(companyId, jobRows[0], { retellCallId: threadId })
      .catch((err) => logger.error("ConfirmationAgent cancel_job mirror failed", { error: err.message, companyId }));
  }

  await todosDb
    .create({
      companyId, callId: null,
      type: todosDb.TODO_TYPES.APPOINTMENT_CANCELLED,
      isTest: false, priority: "low",
      metadata: { thread_id: threadId, appointment_id: String(appointment.id), job_id: String(existing.job_id), scope, reason },
    })
    .catch((err) => logger.warn("Failed to raise APPOINTMENT_CANCELLED todo", { error: err.message, companyId }));

  if (threadId) await chatLinksDb.setStateByToken(threadId, "canceled").catch(() => {});
  logger.info("ConfirmationAgent tool: cancel_appointment", { companyId, appointment_id, scope, reason });
  return JSON.stringify({ success: true, appointment_id: appointment.id, scope, job_status: job?.status ?? null });
}

module.exports = {
  name: "cancel_appointment",
  description: "Cancel one appointment (appointment_only) or the entire job (entire_job) — always ask which, and why, before calling this.",
  schema,
  run,
};
