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
const conversationSummary = require("./conversation-summary");

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

/** Company timezone, for rendering visit dates the office will recognise. */
async function companyTimezone(companyId) {
  try {
    const { rows } = await db.query(`SELECT default_timezone FROM companies WHERE id = $1`, [companyId]);
    return rows[0]?.default_timezone || "UTC";
  } catch {
    return "UTC";
  }
}

function commentMarker(retellCallId) {
  return `[clara-call:${retellCallId}]`;
}

/**
 * @param {string|null} llmSummary  the model's sentence, or null → fall back to
 *   Retell's own call summary, which is what shipped before.
 * @param {string|null} whoConfirmed the contact we actually spoke to.
 */
function buildCommentContent(label, callSummary, retellCallId, { llmSummary = null, whoConfirmed = null, plainSummary = null } = {}) {
  const fallback = llmSummary || plainSummary || (callSummary && String(callSummary).trim()) || "No summary available.";
  return [
    `Call outcome: the customer ${label}.`,
    `Who confirmed: ${whoConfirmed || "unknown"}`,
    `Summary: ${fallback}`,
    "",
    commentMarker(retellCallId),
  ].join("\n");
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
  return ["tech", "schedule", "billing"];
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
 * Idempotency: GET existing comments on the entity and check whether one
 * already contains this marker. Fails open (returns false) so a read error
 * never blocks a legitimate write.
 */
async function hasCommentWithMarker(companyId, entityType, entityId, marker) {
  try {
    const res = await stLoggedRequest(
      companyId,
      "GET",
      `/comment?entityId=${encodeURIComponent(entityId)}&entityType=${encodeURIComponent(entityType)}`,
      { context: "comment.get" }
    );
    if (!res.ok) return false;
    const list = Array.isArray(res.data) ? res.data : res.data?.comments || [];
    return list.some((c) => typeof c?.content === "string" && c.content.includes(marker));
  } catch (err) {
    logger.warn("servicetrade comment: GET existing failed; proceeding", { error: err.message, companyId, entityId });
    return false;
  }
}

async function alreadyPosted(companyId, entityType, entityId, retellCallId) {
  return hasCommentWithMarker(companyId, entityType, entityId, commentMarker(retellCallId));
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

  // Who we actually spoke to. scheduled_calls.recipient_name is set when the
  // call went to a nominated contact (migration 081) rather than the customer
  // record itself, so it is preferred over customer_name.
  const whoConfirmed = scheduledCall?.recipient_name || scheduledCall?.customer_name || null;

  // Best-effort: a failure here leaves llmSummary null and buildCommentContent
  // falls back to Retell's own summary, which is what shipped before.
  let llmSummary = null;
  let plainSummary = null;
  try {
    const [facts, transcript] = await Promise.all([
      conversationSummary.buildOutcomeFacts(companyId, [scheduledCall?.appointment_id], await companyTimezone(companyId)),
      conversationSummary.loadCallTranscript(companyId, retellCallId),
    ]);
    plainSummary = conversationSummary.renderPlainSummary(facts.visits);
    llmSummary = await conversationSummary.summarizeConversation({
      channel: "phone call", personName: whoConfirmed, outcomeFacts: facts.lines, transcript,
    });
  } catch (err) {
    logger.warn("servicetrade comment: summary step failed, using fallback", { companyId, retellCallId, error: err.message });
  }

  const content = buildCommentContent(label, callSummary, retellCallId, { llmSummary, whoConfirmed, plainSummary });

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

/**
 * Chat-agent counterpart to commentMarker/buildCommentContent. Embeds the
 * message count at post time (not just the thread id) so a conversation
 * that's reopened later and ends again produces a fresh, distinct marker —
 * the longer history naturally makes each ending unique, with no separate
 * "already ended once" bookkeeping needed.
 */
function chatCommentMarker(threadId, messageCount) {
  return `[clara-chat:${threadId}:${messageCount}]`;
}

/**
 * @param {string|null} llmSummary  the model's sentence, or null → fall back to
 *   the deterministic tool-derived lines, which is what shipped before.
 * @param {string|null} whoConfirmed the contact we were actually talking to.
 */
/**
 * One id-free line describing what the conversation actually did, derived from
 * the deterministic tool-call lines rather than from anything the model wrote.
 */
function describeChatOutcome(summaryLines) {
  const counts = { confirmed: 0, rescheduled: 0, cancelled: 0, booked: 0 };
  for (const line of summaryLines) {
    if (/\bconfirmed\b/i.test(line)) {
      const m = line.match(/confirmed (\d+) appointment/i);
      counts.confirmed += m ? Number(m[1]) : 1;
    } else if (/\brescheduled\b/i.test(line)) counts.rescheduled += 1;
    else if (/\bcancelled\b/i.test(line)) counts.cancelled += 1;
    else if (/\bbooked\b/i.test(line)) counts.booked += 1;
  }
  const parts = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (counts.confirmed) parts.push(`confirmed ${plural(counts.confirmed, "visit")}`);
  if (counts.rescheduled) parts.push(`rescheduled ${plural(counts.rescheduled, "visit")}`);
  if (counts.cancelled) parts.push(`cancelled ${plural(counts.cancelled, "visit")}`);
  if (counts.booked) parts.push(`booked ${plural(counts.booked, "visit")}`);
  return parts.length ? `the customer ${parts.join(", ")}.` : "see summary below.";
}

function buildChatCommentContent(summaryLines, threadId, messageCount, { llmSummary = null, whoConfirmed = null, plainSummary = null } = {}) {
  // Counts, not ids. The outcome line is computed from the real tool calls, so
  // it cannot be wrong; stripping the "#110726" keeps it readable for the office.
  const outcome = describeChatOutcome(summaryLines);
  // Fallbacks in order: the model's sentence, then the deterministic
  // services-and-dates rendering, then the raw tool lines as a last resort.
  const summary = llmSummary || plainSummary || summaryLines.map((l) => `- ${l}`).join("\n");
  return [
    `Chat outcome: ${outcome}`,
    `Who confirmed: ${whoConfirmed || "unknown"}`,
    `Summary: ${summary}`,
    "",
    chatCommentMarker(threadId, messageCount),
  ].join("\n");
}

/**
 * Post a single job-level comment summarizing a completed confirmation-agent
 * chat conversation. Unlike postCallComment (built around Retell's fuzzy
 * outcome/custom call-analysis fields), the caller here already knows
 * exactly what happened — summaryLines is built from real tool calls/results,
 * not derived from any ambiguous signal — so there's no label-guessing step.
 *
 * Deliberately posts to the parent JOB only, not a specific appointment: a
 * chat conversation can touch several appointments on the job (confirm one,
 * reschedule another), so one job-level comment listing everything that
 * happened is simpler than picking an arbitrary "the" appointment.
 *
 * Best-effort — never throws into the chat turn.
 *
 * @param {object} args
 * @param {number|string} args.companyId
 * @param {number|string} args.jobId
 * @param {string} args.threadId       chat_links.token (this conversation's thread id)
 * @param {string[]} args.summaryLines human-readable lines, one per successful action
 * @param {number} args.messageCount   full message count at post time (see chatCommentMarker)
 */
async function postConfirmationAgentComment({ companyId, jobId, threadId, summaryLines, messageCount, appointmentIds = [], recipientName = null }) {
  if (!summaryLines || summaryLines.length === 0) {
    logger.info("servicetrade comment (chat): nothing reportable; skipping", { companyId, threadId, jobId });
    return;
  }

  const enabled = await isCommentWritebackEnabled(companyId);
  if (!enabled) {
    logger.info("servicetrade comment (chat): crm_comment_writeback_enabled is FALSE for company; skipping", { companyId, threadId });
    return;
  }

  const targets = await resolveTargets(companyId, "customer_confirmation", { job_id: String(jobId), appointment_id: null });
  if (targets.length === 0) {
    logger.warn("servicetrade comment (chat): no servicetrade entity resolved; skipping (see [resolve] logs above)", { companyId, threadId, jobId });
    return;
  }

  // Who we were actually chatting with. Falls back to the customer on the job
  // when the link went to the customer record rather than a nominated contact.
  let whoConfirmed = recipientName;
  if (!whoConfirmed) {
    const { rows } = await db.query(
      `SELECT COALESCE(NULLIF(TRIM(cu.full_name), ''),
                       TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name))) AS name
         FROM jobs j LEFT JOIN customers cu ON cu.id = j.customer_id
        WHERE j.id = $1 AND j.company_id = $2`,
      [jobId, companyId]
    ).catch(() => ({ rows: [] }));
    whoConfirmed = rows[0]?.name || null;
  }

  // Best-effort: on any failure llmSummary stays null and the deterministic
  // tool-derived lines are used instead — the text shipped before this change.
  let llmSummary = null;
  let plainSummary = null;
  try {
    const [facts, transcript] = await Promise.all([
      conversationSummary.buildOutcomeFacts(companyId, appointmentIds, await companyTimezone(companyId)),
      conversationSummary.loadChatTranscript(companyId, threadId),
    ]);
    plainSummary = conversationSummary.renderPlainSummary(facts.visits);
    llmSummary = await conversationSummary.summarizeConversation({
      channel: "web chat", personName: whoConfirmed, outcomeFacts: facts.lines, transcript,
    });
  } catch (err) {
    logger.warn("servicetrade comment (chat): summary step failed, using fallback", { companyId, threadId, error: err.message });
  }

  const content = buildChatCommentContent(summaryLines, threadId, messageCount, { llmSummary, whoConfirmed, plainSummary });
  const marker = chatCommentMarker(threadId, messageCount);
  const posts = targets.flatMap((t) => t.entityIds.map((entityId) => ({ entityKey: t.entityKey, entityType: t.entityType, entityId })));

  logger.info("servicetrade comment (chat): posting", { companyId, threadId, count: posts.length, entities: posts.map((p) => `${p.entityKey}:${p.entityId}`) });
  for (const { entityKey, entityType, entityId } of posts) {
    try {
      if (await hasCommentWithMarker(companyId, entityType, entityId, marker)) {
        logger.info("servicetrade comment (chat): already posted for this conversation state; skipping", { companyId, entityKey, entityId, threadId });
        continue;
      }
      const body = buildCommentBody({ entityId, entityType, content });
      const res = await stLoggedRequest(companyId, "POST", "/comment", { body, context: "comment.post" });
      if (!res.ok) {
        logger.error("servicetrade comment (chat): POST failed", { companyId, entityKey, entityId, status: res.status, messages: res.messages, data: res.data });
      } else {
        logger.info("servicetrade comment (chat): posted OK", { companyId, entityKey, entityId, threadId, commentId: res.data?.id ?? null });
      }
      await callLogsDb
        .insert({
          companyId,
          callId: null,
          retellCallId: threadId,
          eventType: "servicetrade_comment_posted",
          payload: {
            ok: res.ok,
            status: res.status,
            entity_key: entityKey,
            entity_type: entityType,
            entity_id: entityId,
            comment_id: res.data?.id ?? null,
            summary_lines: summaryLines,
            messages: res.ok ? undefined : res.messages,
          },
        })
        .catch(() => {});
    } catch (err) {
      logger.error("servicetrade comment (chat): unexpected error", { error: err.message, companyId, entityId, threadId });
    }
  }
}

module.exports = {
  postCallComment,
  postConfirmationAgentComment,
  appliesToCallType,
  isCommentWritebackEnabled,
  // exported for tests / live verification
  buildCommentBody,
  buildCommentContent,
  deriveLabel,
  resolveTargets,
};
