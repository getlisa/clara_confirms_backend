/**
 * Batch-confirm several (or all) upcoming appointments on the current job —
 * mirrors retell-tools.js's POST /confirm_job_appointments. Kept as ONE tool
 * (not a client-side loop over confirm_appointment) for the same reason the
 * original has: one job-status recompute, and models drop writes across long
 * sequential tool chains.
 */
const { z } = require("zod");
const db = require("../../../db");
const jobsDb = require("../../../db/jobs");
const chatLinksDb = require("../../../db/chat-links");
const { buildJobConfirmationContext } = require("../../../services/job-confirmation-context");
const { syncJobConfirmationStatus } = require("../../../services/job-confirmation-status");
const { resolveConfirmerLabel } = require("../confirmer-label");
const logger = require("../../../utils/logger");

const schema = z.object({
  confirm_all: z.boolean().nullish().describe("true to confirm every remaining unconfirmed upcoming appointment on this job."),
  appointment_ids: z.array(z.union([z.string(), z.number()])).nullish().describe("Specific appointment ids to confirm, if not confirming all."),
});

async function run({ confirm_all, appointment_ids }, config) {
  const { companyId, jobId, threadId, recipientContactId } = config?.configurable?.ctx || {};
  const wantsAll = confirm_all === true;
  const requestedIds = wantsAll ? [] : (appointment_ids || []).map((v) => String(v).trim()).filter(Boolean);
  if (!wantsAll && requestedIds.length === 0) {
    return JSON.stringify({ success: false, error: "Pass confirm_all=true or a non-empty appointment_ids list" });
  }

  const ctx = await buildJobConfirmationContext(companyId, jobId);
  if (!ctx.ok) return JSON.stringify({ success: false, error: ctx.error });

  const upcomingById = new Map(ctx.appointments.upcoming.map((a) => [String(a.appointment_id), a]));
  const targets = [];
  const skipped = [];

  if (wantsAll) {
    targets.push(...ctx.appointments.upcoming.filter((a) => !a.customer_confirmed));
  } else {
    for (const id of requestedIds) {
      const appt = upcomingById.get(id);
      if (!appt) skipped.push({ appointment_id: id, reason: "not_an_upcoming_appointment_on_this_job" });
      else if (appt.customer_confirmed) skipped.push({ appointment_id: id, reason: "already_confirmed" });
      else targets.push(appt);
    }
  }

  if (targets.length) {
    const ids = targets.map((a) => a.appointment_id);
    await jobsDb.bulkConfirmAppointments(companyId, ids);

    // Same jsonb-merge convention as confirm-appointment.js — record which
    // conversation/recipient confirmed these, without clobbering existing
    // additional_information (ServiceTrade sync metadata etc.).
    const confirmedByLabel = await resolveConfirmerLabel(companyId, recipientContactId);
    await db.query(
      `UPDATE appointments
          SET additional_information = COALESCE(additional_information, '{}'::jsonb)
                || jsonb_build_object('confirmed_by_thread_id', $1::text, 'confirmed_by_label', $2::text),
              updated_at = NOW()
        WHERE company_id = $3 AND id = ANY($4::int[])`,
      [threadId, confirmedByLabel, companyId, ids]
    );
  }

  if (targets.length && threadId) await chatLinksDb.setStateByToken(threadId, "confirmation_accepted").catch(() => {});
  const jobStatus = targets.length ? await syncJobConfirmationStatus(companyId, ctx.job.id) : ctx.job.status;
  logger.info("ConfirmationAgent tool: confirm_job_appointments", { companyId, jobId, confirmAll: wantsAll, confirmed: targets.length, skipped: skipped.length, jobStatus });

  return JSON.stringify({
    success: true,
    confirmed: targets.map((a) => a.appointment_id),
    skipped,
    job_status: jobStatus,
    ...(targets.length === 0 && { message: "Nothing left to confirm — those appointments were already confirmed." }),
  });
}

module.exports = {
  name: "confirm_job_appointments",
  description: "Batch-confirm several or all remaining unconfirmed upcoming appointments on the current job in one call.",
  schema,
  run,
};
