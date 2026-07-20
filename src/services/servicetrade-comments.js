/**
 * ServiceTrade comment write-back.
 *
 * After an ANSWERED call, post a comment onto the corresponding ServiceTrade
 * entity summarizing the outcome:
 *   - confirmation calls (customer/technician) → the Appointment (entityType 16)
 *   - service-opportunity follow-up            → each ServiceRequest (entityType 18)
 *
 * Voicemail / no-answer calls never reach here (gated by the caller). Unclear
 * outcomes are skipped. Only rows synced from ServiceTrade (source='servicetrade'
 * with a numeric external_ref) are eligible — our source='manual' test rows are
 * skipped automatically.
 *
 * Ships behind the SERVICETRADE_COMMENT_WRITEBACK flag (default OFF) so nothing
 * writes to a real CRM until the POST /comment body shape is verified live.
 */

const db = require("../db");
const { stLoggedRequest } = require("./servicetrade-api");
const entityTypesDb = require("../db/servicetrade-entity-types");
const callSettingsDb = require("../db/call-settings");
const callLogsDb = require("../db/call-logs");
const logger = require("../utils/logger");

const CALL_TYPES_WITH_WRITEBACK = [
  "customer_confirmation",
  "technician_confirmation",
  "service_opportunity_followup",
];

/** Whether comment write-back could apply to this call type (cheap pre-gate). */
function appliesToCallType(callType) {
  return CALL_TYPES_WITH_WRITEBACK.includes(callType);
}

/**
 * Per-company enablement — driven by the `crm_comment_writeback_enabled` call
 * setting (toggled from the UI), replacing the old env flag. Off by default.
 */
async function isCommentWritebackEnabled(companyId) {
  const cs = await callSettingsDb.getByCompanyId(companyId).catch(() => null);
  return cs?.crm_comment_writeback_enabled === true;
}

/** true when `v` is a non-empty numeric ServiceTrade id (skips 'TEST-SO-*' etc.). */
function isNumericRef(v) {
  return v != null && v !== "" && /^\d+$/.test(String(v));
}

/**
 * Decide the customer-facing outcome label for this call, or null to skip.
 * Confirmation calls read the normalized `outcome`; service-opportunity calls
 * read `custom.booking_outcome`.
 */
function deriveLabel(callType, outcome, custom) {
  if (callType === "customer_confirmation" || callType === "technician_confirmation") {
    if (outcome.appointmentConfirmed === "yes") return "confirmed the appointment";
    if (outcome.cancellationRequested === true) return "cancelled the appointment";
    if (outcome.rescheduleRequested === true) return "requested a reschedule";
    return null; // unclear → don't post
  }
  if (callType === "service_opportunity_followup") {
    const bo = custom?.booking_outcome ?? null;
    if (bo === "booked" || bo === "partially_booked") return "agreed to book the recommended service";
    if (bo === "declined") return "declined the recommended service";
    return null; // needs_to_check / callback_requested / no_answer → don't post
  }
  return null;
}

function commentMarker(retellCallId) {
  return `[clara-call:${retellCallId}]`;
}

function buildCommentContent(label, callSummary, retellCallId) {
  const summary = (callSummary && String(callSummary).trim()) || "No summary available.";
  return `Clara call outcome: the customer ${label}.\n\nCall summary: ${summary}\n\n${commentMarker(retellCallId)}`;
}

/**
 * The one place the ServiceTrade POST /comment body shape lives.
 * Confirmed against ServiceTrade's documented shape:
 *   { entityId, entityType, content, visibility: [...], pinned }
 * `visibility` is an array of audience strings (e.g. ["public"]); overridable via
 * SERVICETRADE_COMMENT_VISIBILITY (comma-separated) so it can be tightened to an
 * internal-only audience without a code change. entityId stays a Number — all
 * current ServiceTrade ids are < 2^53 (JS-safe).
 */
function commentVisibility() {
  const raw = process.env.SERVICETRADE_COMMENT_VISIBILITY;
  if (raw && raw.trim()) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ["public"];
}

function buildCommentBody({ entityId, entityType, content }) {
  return {
    entityId: Number(entityId),
    entityType: Number(entityType),
    content,
    visibility: commentVisibility(),
    pinned: false,
  };
}

/**
 * Resolve the ServiceTrade entities to comment on for this call. Returns an
 * array of targets (a call may write to more than one entity) — confirmation
 * calls comment on BOTH the appointment and the parent job, whichever exist.
 * @returns {Promise<Array<{entityKey:string, entityType:number, entityIds:string[]}>>}
 */
async function resolveTargets(companyId, callType, scheduledCall) {
  const targets = [];

  if (callType === "customer_confirmation" || callType === "technician_confirmation") {
    // Appointment (entityType 16), via scheduled_calls.appointment_id.
    const apptCfg = await entityTypesDb.getByKey("appointment");
    if (!apptCfg) {
      logger.warn("servicetrade comment[resolve]: no 'appointment' entity-type config seeded", { companyId });
    } else if (!scheduledCall.appointment_id) {
      logger.info("servicetrade comment[resolve]: no appointment_id on scheduled_call — skipping appointment target", { companyId, jobId: scheduledCall.job_id });
    } else {
      const { rows } = await db.query(
        `SELECT external_ref, source FROM appointments
         WHERE id = $1 AND company_id = $2`,
        [scheduledCall.appointment_id, companyId]
      );
      const row = rows[0];
      if (!row) {
        logger.info("servicetrade comment[resolve]: appointment row not found", { companyId, appointmentId: scheduledCall.appointment_id });
      } else if (row.source !== "servicetrade") {
        logger.info("servicetrade comment[resolve]: appointment not from servicetrade — skipping", { companyId, appointmentId: scheduledCall.appointment_id, source: row.source });
      } else if (!isNumericRef(row.external_ref)) {
        logger.info("servicetrade comment[resolve]: appointment external_ref not numeric — skipping", { companyId, appointmentId: scheduledCall.appointment_id, external_ref: row.external_ref });
      } else {
        targets.push({ entityKey: "appointment", entityType: apptCfg.servicetrade_entity_type, entityIds: [String(row.external_ref)] });
      }
    }

    // Parent Job (entityType 3), via scheduled_calls.job_id (a real platform job id string).
    const jobCfg = await entityTypesDb.getByKey("job");
    const jobKey = scheduledCall.job_id || "";
    if (!jobCfg) {
      logger.warn("servicetrade comment[resolve]: no 'job' entity-type config seeded", { companyId });
    } else if (!/^\d+$/.test(jobKey)) {
      logger.info("servicetrade comment[resolve]: job_id is not a numeric platform id — skipping job target", { companyId, jobId: jobKey });
    } else {
      const { rows } = await db.query(
        `SELECT external_ref, source FROM jobs
         WHERE id = $1 AND company_id = $2`,
        [Number(jobKey), companyId]
      );
      const row = rows[0];
      if (!row) {
        logger.info("servicetrade comment[resolve]: job row not found", { companyId, jobId: jobKey });
      } else if (row.source !== "servicetrade") {
        logger.info("servicetrade comment[resolve]: job not from servicetrade — skipping", { companyId, jobId: jobKey, source: row.source });
      } else if (!isNumericRef(row.external_ref)) {
        logger.info("servicetrade comment[resolve]: job external_ref not numeric — skipping", { companyId, jobId: jobKey, external_ref: row.external_ref });
      } else {
        targets.push({ entityKey: "job", entityType: jobCfg.servicetrade_entity_type, entityIds: [String(row.external_ref)] });
      }
    }
    return targets;
  }

  if (callType === "service_opportunity_followup") {
    const cfg = await entityTypesDb.getByKey("service_request");
    const jobId = scheduledCall.job_id || "";
    if (!cfg) {
      logger.warn("servicetrade comment[resolve]: no 'service_request' entity-type config seeded", { companyId });
      return targets;
    }
    if (!jobId.startsWith("service_opportunity:")) {
      logger.info("servicetrade comment[resolve]: job_id is not a service_opportunity key — skipping", { companyId, jobId });
      return targets;
    }
    const soIds = jobId
      .slice("service_opportunity:".length)
      .split("-")
      .map(Number)
      .filter((n) => Number.isInteger(n));
    if (soIds.length === 0) {
      logger.info("servicetrade comment[resolve]: no service_opportunity ids parsed from job_id", { companyId, jobId });
      return targets;
    }
    const { rows } = await db.query(
      `SELECT id, external_ref, source FROM service_opportunities
       WHERE id = ANY($1::int[]) AND company_id = $2`,
      [soIds, companyId]
    );
    logger.info("servicetrade comment[resolve]: service_opportunity rows", {
      companyId, requestedIds: soIds,
      found: rows.map((r) => ({ id: r.id, source: r.source, external_ref: r.external_ref })),
    });
    const entityIds = rows
      .filter((r) => r.source === "servicetrade" && isNumericRef(r.external_ref))
      .map((r) => String(r.external_ref));
    if (entityIds.length > 0) {
      targets.push({ entityKey: "service_request", entityType: cfg.servicetrade_entity_type, entityIds });
    } else {
      logger.info("servicetrade comment[resolve]: no eligible servicetrade service_requests (need source='servicetrade' + numeric external_ref) — skipping", { companyId, jobId });
    }
    return targets;
  }

  return targets;
}

/**
 * Idempotency: GET existing comments on the entity and check whether we already
 * posted one for this call (marker match). Fails open (returns false) so a read
 * error never blocks a legitimate write.
 */
async function alreadyPosted(companyId, entityType, entityId, retellCallId) {
  try {
    const res = await stLoggedRequest(
      companyId,
      "GET",
      `/comment?entityId=${encodeURIComponent(entityId)}&entityType=${encodeURIComponent(entityType)}`,
      { context: "comment.get" }
    );
    if (!res.ok) return false;
    const list = Array.isArray(res.data) ? res.data : res.data?.comments || [];
    const marker = commentMarker(retellCallId);
    return list.some((c) => typeof c?.content === "string" && c.content.includes(marker));
  } catch (err) {
    logger.warn("servicetrade comment: GET existing failed; proceeding", { error: err.message, companyId, entityId });
    return false;
  }
}

/**
 * Post a comment to ServiceTrade for a completed, answered call.
 * Best-effort — never throws into the webhook path.
 *
 * @param {object} args
 * @param {number|string} args.companyId
 * @param {object} args.scheduledCall  full scheduled_calls row (call_type, job_id, appointment_id, …)
 * @param {object} args.outcome        normalized outcome from handleCallAnalyzed
 * @param {object} args.custom         call_analysis.custom_analysis_data
 * @param {string} args.callSummary
 * @param {string} args.retellCallId
 * @param {number|null} [args.callId]  our calls.id (for call_logs linkage)
 */
async function postCallComment({ companyId, scheduledCall, outcome, custom, callSummary, retellCallId, callId = null }) {
  const callType = scheduledCall?.call_type;
  logger.info("servicetrade comment: begin", {
    companyId, callType, retellCallId,
    jobId: scheduledCall?.job_id, appointmentId: scheduledCall?.appointment_id,
  });

  if (!appliesToCallType(callType)) {
    logger.info("servicetrade comment: call_type not eligible for write-back; skipping", { companyId, callType, retellCallId });
    return;
  }

  const enabled = await isCommentWritebackEnabled(companyId);
  if (!enabled) {
    logger.info("servicetrade comment: crm_comment_writeback_enabled is FALSE for company; skipping", { companyId, callType, retellCallId });
    return;
  }

  const label = deriveLabel(callType, outcome, custom);
  if (!label) {
    logger.info("servicetrade comment: no reportable outcome; skipping", {
      companyId, callType, retellCallId,
      appointmentConfirmed: outcome?.appointmentConfirmed,
      cancellationRequested: outcome?.cancellationRequested,
      rescheduleRequested: outcome?.rescheduleRequested,
      bookingOutcome: custom?.booking_outcome ?? null,
    });
    return;
  }
  logger.info("servicetrade comment: outcome label resolved", { companyId, callType, retellCallId, label });

  const targets = await resolveTargets(companyId, callType, scheduledCall);
  if (targets.length === 0) {
    logger.warn("servicetrade comment: no servicetrade entity resolved to comment on; skipping (see [resolve] logs above for reason)", { companyId, callType, retellCallId });
    return;
  }
  logger.info("servicetrade comment: resolved targets", {
    companyId, callType, retellCallId,
    targets: targets.map((t) => ({ entityKey: t.entityKey, entityType: t.entityType, entityIds: t.entityIds })),
  });

  const content = buildCommentContent(label, callSummary, retellCallId);

  // Flatten to (entityKey, entityType, entityId) so we post one comment per
  // entity — a confirmation call writes to both the appointment and the job.
  const posts = targets.flatMap((t) =>
    t.entityIds.map((entityId) => ({ entityKey: t.entityKey, entityType: t.entityType, entityId }))
  );

  logger.info("servicetrade comment: posting", { companyId, retellCallId, count: posts.length, entities: posts.map((p) => `${p.entityKey}:${p.entityId}`) });
  for (const { entityKey, entityType, entityId } of posts) {
    try {
      if (await alreadyPosted(companyId, entityType, entityId, retellCallId)) {
        logger.info("servicetrade comment: already posted for this call; skipping", { companyId, entityKey, entityId, retellCallId });
        continue;
      }
      const body = buildCommentBody({ entityId, entityType, content });
      const res = await stLoggedRequest(companyId, "POST", "/comment", { body, context: "comment.post" });
      if (!res.ok) {
        logger.error("servicetrade comment: POST failed", { companyId, entityKey, entityId, status: res.status, messages: res.messages, data: res.data });
      } else {
        logger.info("servicetrade comment: posted OK", { companyId, entityKey, entityId, retellCallId, commentId: res.data?.id ?? null });
      }
      await callLogsDb
        .insert({
          companyId,
          callId,
          retellCallId,
          eventType: "servicetrade_comment_posted",
          payload: {
            ok: res.ok,
            status: res.status,
            entity_key: entityKey,
            entity_type: entityType,
            entity_id: entityId,
            comment_id: res.data?.id ?? null,
            label,
            messages: res.ok ? undefined : res.messages,
          },
        })
        .catch(() => {});
    } catch (err) {
      logger.error("servicetrade comment: unexpected error", { error: err.message, companyId, entityId, retellCallId });
    }
  }
}

module.exports = {
  postCallComment,
  appliesToCallType,
  isCommentWritebackEnabled,
  // exported for tests / live verification
  buildCommentBody,
  buildCommentContent,
  deriveLabel,
  resolveTargets,
};
