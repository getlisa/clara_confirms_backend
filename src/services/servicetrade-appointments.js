/**
 * Mirror in-call appointment/job changes to ServiceTrade.
 *
 * The platform DB is the source of truth: the Retell write-tool handlers write
 * the platform row FIRST (unchanged), then call these mirrors best-effort. A
 * failed CRM write never breaks the call — it raises a CRM_SYNC todo so a human
 * reconciles ServiceTrade.
 *
 * Gated by `agent_can_make_changes` (the same flag that attaches the write tools
 * to the agent). All ServiceTrade calls go through stLoggedRequest so the
 * payload/status/response are logged.
 *
 * Scope: reschedule appointment (PUT /appointment/{id}), create appointment
 * (POST /appointment → stamp the returned id back), reschedule job
 * (PUT /job/{id}), cancel appointment/job (PUT .../{id} status). Confirm is
 * handled by the comment + service link, not here.
 */

const db = require("../db");
const { stLoggedRequest } = require("./servicetrade-api");
const callSettingsDb = require("../db/call-settings");
const todosDb = require("../db/todos");
const logger = require("../utils/logger");

/** ServiceTrade windowStart/windowEnd/scheduledDate are Unix epoch SECONDS. */
function toEpochSeconds(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function isNumericRef(v) {
  return v != null && v !== "" && /^\d+$/.test(String(v));
}

// ServiceTrade's real status enum uses American spelling — confirmed from real
// synced data (servicetrade_appointments.status includes "canceled_by_vendor").
// "canceled_by_customer" for the appointment and "canceled" for the job are
// inferred from that pattern, not a captured cancel request — this constant is
// the one place to fix them once confirmed.
const ST_APPOINTMENT_CANCELED_STATUS = process.env.SERVICETRADE_APPOINTMENT_CANCELED_STATUS || "canceled_by_customer";
const ST_JOB_CANCELED_STATUS = process.env.SERVICETRADE_JOB_CANCELED_STATUS || "canceled";

async function agentCanMakeChanges(companyId) {
  const cs = await callSettingsDb.getByCompanyId(companyId).catch(() => null);
  return cs ? cs.agent_can_make_changes !== false : false;
}

async function raiseCrmSyncTodo(companyId, { action, entity, entityId, error, retellCallId = null }) {
  await todosDb
    .create({
      companyId,
      callId: null,
      type: todosDb.TODO_TYPES.CRM_SYNC,
      isTest: false,
      metadata: { action, entity, entity_id: entityId != null ? String(entityId) : null, error: error ? String(error).slice(0, 2000) : null, retell_call_id: retellCallId },
    })
    .catch((err) => logger.warn("crm-sync: failed to raise CRM_SYNC todo", { error: err.message, companyId, action }));
}

// ── Body builders (single place to adjust ServiceTrade shapes once confirmed) ─
function buildAppointmentWindowBody({ scheduledStart, scheduledEnd }) {
  const body = {};
  const ws = toEpochSeconds(scheduledStart);
  const we = toEpochSeconds(scheduledEnd);
  if (ws != null) body.windowStart = ws;
  if (we != null) body.windowEnd = we;
  return body;
}

// ── Shared PUT helpers (guard + call + log + CRM_SYNC-on-failure, once) ──────

/** Guarded PUT against a ServiceTrade appointment. Returns a uniform result shape. */
async function putAppointment(companyId, apptRow, body, { action, retellCallId = null } = {}) {
  if (!(await agentCanMakeChanges(companyId))) return { skipped: "agent_can_make_changes=false" };
  if (!apptRow || apptRow.source !== "servicetrade" || !isNumericRef(apptRow.external_ref)) {
    logger.info(`crm-sync[${action}]: not a servicetrade appointment; skipping`, { companyId, apptId: apptRow?.id, source: apptRow?.source, external_ref: apptRow?.external_ref });
    return { skipped: "not_servicetrade" };
  }
  const ref = String(apptRow.external_ref);
  try {
    const res = await stLoggedRequest(companyId, "PUT", `/appointment/${encodeURIComponent(ref)}`, { body, context: "appointment.update" });
    if (!res.ok) {
      await raiseCrmSyncTodo(companyId, { action, entity: "appointment", entityId: ref, error: JSON.stringify(res.messages || res.status), retellCallId });
      return { ok: false, status: res.status };
    }
    logger.info(`crm-sync[${action}]: updated in ServiceTrade`, { companyId, ref });
    return { ok: true };
  } catch (err) {
    await raiseCrmSyncTodo(companyId, { action, entity: "appointment", entityId: ref, error: err.message, retellCallId });
    return { ok: false, error: err.message };
  }
}

/** Guarded PUT against a ServiceTrade job. Returns a uniform result shape. */
async function putJob(companyId, jobRow, body, { action, retellCallId = null } = {}) {
  if (!(await agentCanMakeChanges(companyId))) return { skipped: "agent_can_make_changes=false" };
  if (!jobRow || jobRow.source !== "servicetrade" || !isNumericRef(jobRow.external_ref)) {
    logger.info(`crm-sync[${action}]: not a servicetrade job; skipping`, { companyId, jobId: jobRow?.id, source: jobRow?.source });
    return { skipped: "not_servicetrade" };
  }
  const ref = String(jobRow.external_ref);
  try {
    const res = await stLoggedRequest(companyId, "PUT", `/job/${encodeURIComponent(ref)}`, { body, context: "job.update" });
    if (!res.ok) {
      await raiseCrmSyncTodo(companyId, { action, entity: "job", entityId: ref, error: JSON.stringify(res.messages || res.status), retellCallId });
      return { ok: false, status: res.status };
    }
    logger.info(`crm-sync[${action}]: updated in ServiceTrade`, { companyId, ref });
    return { ok: true };
  } catch (err) {
    await raiseCrmSyncTodo(companyId, { action, entity: "job", entityId: ref, error: err.message, retellCallId });
    return { ok: false, error: err.message };
  }
}

// ── Mirrors ─────────────────────────────────────────────────────────────────

/**
 * Reschedule: PUT the ServiceTrade appointment's window.
 * @param {object} apptRow  platform appointments row (has external_ref, source)
 */
async function mirrorRescheduleAppointment(companyId, apptRow, { scheduledStart, scheduledEnd, retellCallId = null } = {}) {
  return putAppointment(companyId, apptRow, buildAppointmentWindowBody({ scheduledStart, scheduledEnd }), { action: "reschedule_appointment", retellCallId });
}

/**
 * Cancel: PUT the ServiceTrade appointment's status to canceled.
 * @param {object} apptRow  platform appointments row (has external_ref, source)
 */
async function mirrorCancelAppointment(companyId, apptRow, { retellCallId = null } = {}) {
  return putAppointment(companyId, apptRow, { status: ST_APPOINTMENT_CANCELED_STATUS }, { action: "cancel_appointment", retellCallId });
}

/**
 * Create: POST a ServiceTrade appointment for the (servicetrade) job, then stamp
 * the returned ST id back onto the platform appointment row.
 * @param {object} apptRow       the just-created platform appointment (source='manual', external_ref=null)
 * @param {number} platformJobId the platform job id the appointment belongs to
 */
async function mirrorCreateAppointment(companyId, apptRow, platformJobId, { scheduledStart, scheduledEnd, retellCallId = null } = {}) {
  if (!(await agentCanMakeChanges(companyId))) return { skipped: "agent_can_make_changes=false" };

  const { rows } = await db.query(
    `SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`,
    [platformJobId, companyId]
  );
  const job = rows[0];
  if (!job || job.source !== "servicetrade" || !isNumericRef(job.external_ref)) {
    logger.info("crm-sync[create_appt]: job not from servicetrade; skipping ST create", { companyId, platformJobId, source: job?.source });
    return { skipped: "job_not_servicetrade" };
  }

  const body = { jobId: Number(job.external_ref), ...buildAppointmentWindowBody({ scheduledStart, scheduledEnd }) };
  try {
    const res = await stLoggedRequest(companyId, "POST", "/appointment", { body, context: "appointment.create" });
    const newId = res.data?.id;
    if (!res.ok || !newId) {
      await raiseCrmSyncTodo(companyId, { action: "create_appointment", entity: "job", entityId: job.external_ref, error: JSON.stringify(res.messages || res.status), retellCallId });
      return { ok: false, status: res.status };
    }
    // Stamp the ServiceTrade appointment id back onto the platform row.
    // (updateAppointment's allow-list excludes external_ref/source, so update directly.)
    await db.query(
      `UPDATE appointments
          SET external_ref = $1,
              source = 'servicetrade',
              additional_information = COALESCE(additional_information, '{}'::jsonb)
                || jsonb_build_object('servicetrade_appointment_id', $1::text, 'servicetrade_job_id', $2::text),
              updated_at = NOW()
        WHERE id = $3 AND company_id = $4`,
      [String(newId), String(job.external_ref), apptRow.id, companyId]
    );
    logger.info("crm-sync[create_appt]: created in ServiceTrade + stamped back", { companyId, apptId: apptRow.id, servicetradeApptId: String(newId) });
    return { ok: true, servicetradeAppointmentId: String(newId) };
  } catch (err) {
    await raiseCrmSyncTodo(companyId, { action: "create_appointment", entity: "job", entityId: job.external_ref, error: err.message, retellCallId });
    return { ok: false, error: err.message };
  }
}

/**
 * Reschedule the job's scheduled date: PUT /job/{id}.
 * @param {object} jobRow  platform jobs row (has external_ref, source)
 * @param {string} scheduledDate  "YYYY-MM-DD"
 */
async function mirrorRescheduleJob(companyId, jobRow, { scheduledDate, retellCallId = null } = {}) {
  return putJob(companyId, jobRow, { scheduledDate: toEpochSeconds(scheduledDate) }, { action: "reschedule_job", retellCallId });
}

/**
 * Cancel the job itself: PUT /job/{id} status → canceled. Used for the
 * "entire_job" cancellation scope (not just the one appointment).
 * @param {object} jobRow  platform jobs row (has external_ref, source)
 */
async function mirrorCancelJob(companyId, jobRow, { retellCallId = null } = {}) {
  return putJob(companyId, jobRow, { status: ST_JOB_CANCELED_STATUS }, { action: "cancel_job", retellCallId });
}

module.exports = {
  toEpochSeconds,
  buildAppointmentWindowBody,
  agentCanMakeChanges,
  mirrorRescheduleAppointment,
  mirrorCreateAppointment,
  mirrorRescheduleJob,
  mirrorCancelAppointment,
  mirrorCancelJob,
};
