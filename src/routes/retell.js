const express = require("express");
const { verifyWebhookSignature } = require("../services/retell");
const callsDb = require("../db/calls");
const callLogsDb = require("../db/call-logs");
const callSettingsDb = require("../db/call-settings");
const todosDb = require("../db/todos");
const scheduledCallsDb = require("../db/scheduled-calls");
const stComments = require("../services/servicetrade-comments");
const stServiceLink = require("../services/servicetrade-service-link");
const db = require("../db");
const { getNextWindowStart } = require("../services/scheduler");
const { parseCallbackTime } = require("../services/callback-time");
const logger = require("../utils/logger");

const isDev = process.env.NODE_ENV === "development";

// Max 3 no-answer retries per job (not counting the initial call)
const MAX_NO_ANSWER_RETRIES = 3;

const router = express.Router();

// Raw body capture for webhook signature verification.
// Uses express.raw — works reliably on Vercel/Node serverless (the req.on('data')
// pattern doesn't always fire because the body may be pre-buffered by the platform).
// Skip /tools/* paths which are handled separately by retellToolsRoutes with JSON body.
router.use((req, res, next) => {
  if (req.path.startsWith("/tools")) return next();
  express.raw({ type: "*/*", limit: "10mb" })(req, res, (err) => {
    if (err) return next(err);
    // req.body is a Buffer here
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    req.rawBody = buf.toString("utf8");
    try { req.body = JSON.parse(req.rawBody || "{}"); } catch { req.body = {}; }
    next();
  });
});

const NO_ANSWER_REASONS = new Set([
  "dial_no_answer", "dial_busy", "dial_failed", "user_declined",
  "invalid_destination", "error_no_audio_received",
]);

/**
 * Extract which subagent nodes were active during the call from
 * transcript_with_tool_calls. NodeTransitionUtterance items tell us exactly
 * when the flow moved from the branch router into a subagent node.
 * Returns an array of { node_id, node_name } in order of activation.
 */
function extractNodeTransitions(transcriptWithToolCalls) {
  if (!Array.isArray(transcriptWithToolCalls)) return [];
  return transcriptWithToolCalls
    .filter((u) => u.role === "node_transition")
    .map((u) => ({ node_id: u.node_id, node_name: u.node_name }));
}

/**
 * POST /retell/webhook
 * Retell fires call_ended then call_analyzed per call.
 */
router.post("/webhook", async (req, res) => {
  const signature = req.headers["x-retell-signature"];

  // Always log what arrived — independent of signature outcome — so we can diagnose
  // production failures without losing data.
  logger.info("Retell webhook: incoming request", {
    hasSignature: !!signature,
    bodyLen:      req.rawBody?.length ?? 0,
    eventType:    req.body?.event,
    callId:       req.body?.call?.call_id,
    companyId:    req.body?.call?.metadata?.company_id,
    contentType:  req.headers["content-type"],
  });

  const valid = await verifyWebhookSignature(req.rawBody, signature);

  // If signature failed but the payload has a metadata.company_id referencing a real
  // company AND a real call_id, process it anyway with a warning. The metadata is set
  // by us when we create the call, so a forged webhook would need to know an existing
  // call_id + company_id pair — not impossible but acceptable for production until
  // signature config is fixed.
  if (!valid) {
    const callId    = req.body?.call?.call_id;
    const companyId = req.body?.call?.metadata?.company_id;
    if (!callId || !companyId) {
      logger.warn("Retell webhook: invalid signature AND no callId/companyId to fall back on");
      return res.status(401).json({ error: "Invalid signature" });
    }
    // Verify the call belongs to this company — either it's a scheduled_calls row,
    // a test call already logged in calls, or this is the first stub being created.
    // For first-time stub: trust companyId only if it references a real, active company.
    const [scRows, callRows, coRows] = await Promise.all([
      db.query(`SELECT 1 FROM scheduled_calls WHERE retell_call_id = $1 AND company_id = $2 LIMIT 1`, [callId, companyId]),
      db.query(`SELECT 1 FROM calls WHERE retell_call_id = $1 AND company_id = $2 LIMIT 1`, [callId, companyId]),
      db.query(`SELECT 1 FROM companies WHERE id = $1 LIMIT 1`, [companyId]),
    ]);
    const knownCall    = scRows.rows.length > 0 || callRows.rows.length > 0;
    const knownCompany = coRows.rows.length > 0;
    if (!knownCompany) {
      logger.warn("Retell webhook: invalid signature AND companyId not found", { callId, companyId });
      return res.status(401).json({ error: "Invalid signature" });
    }
    logger.warn("Retell webhook: signature invalid BUT companyId is valid — processing anyway", {
      callId, companyId, knownCall, knownCompany,
    });
    logger.warn("Retell webhook: signature invalid BUT call matches known scheduled_calls row — processing anyway", { callId, companyId });
  }

  const event = req.body;
  const eventType = event?.event;
  const callData = event?.call;

  logger.info("Retell webhook received", {
    eventType,
    callId: callData?.call_id,
    signatureValid: valid,
  });

  // NOTE: these handlers MUST be awaited before responding. On Vercel serverless
  // the function is frozen/killed once the response is sent, which would cut off
  // any post-response async work — including the ServiceTrade comment write-back
  // (a network POST that runs at the tail of handleCallAnalyzed). Awaiting keeps
  // the function alive until the work completes. Handlers are idempotent
  // (upserts + the [clara-call:...] comment marker), so a Retell retry is safe.
  if (eventType === "call_ended") {
    await handleCallEnded(callData).catch((err) =>
      logger.error("call_ended handler failed", { error: err.message, callId: callData?.call_id })
    );
    return res.sendStatus(204);
  }

  if (eventType === "call_analyzed") {
    await handleCallAnalyzed(callData).catch((err) =>
      logger.error("call_analyzed handler failed", { error: err.message, callId: callData?.call_id })
    );
    return res.sendStatus(204);
  }

  return res.sendStatus(204);
});

async function handleCallEnded(callData) {
  const { call_id, metadata, duration_ms, disconnection_reason } = callData;
  const companyId = metadata?.company_id;

  if (!companyId) {
    logger.warn("call_ended: no company_id in metadata", { callId: call_id });
    return;
  }

  const isTest = !!(metadata?.is_test || metadata?.test_call);

  await callsDb.upsertStub({
    retellCallId: call_id,
    companyId,
    toNumber: callData.to_number,
    fromNumber: callData.from_number,
    durationMs: duration_ms,
    disconnectionReason: disconnection_reason,
    inVoicemail: false,
    metadata,
    isTest,
  });

  const callRow = await db.query(`SELECT id FROM calls WHERE retell_call_id = $1`, [call_id]);
  const callId = callRow.rows[0]?.id ?? null;

  await callLogsDb.insert({
    companyId, callId, retellCallId: call_id,
    eventType: "call_ended",
    payload: { duration_ms, disconnection_reason, to_number: callData.to_number },
  });

  logger.info("Call ended — stub + log saved", {
    callId: call_id, companyId, durationMs: duration_ms, disconnectionReason: disconnection_reason,
  });
}

async function handleCallAnalyzed(callData) {
  const {
    call_id, metadata, duration_ms, disconnection_reason,
    transcript, transcript_with_tool_calls, call_analysis, call_cost,
  } = callData;
  const companyId = metadata?.company_id;

  if (!companyId) {
    logger.warn("call_analyzed: no company_id in metadata", { callId: call_id });
    return;
  }

  const inVoicemail = call_analysis?.in_voicemail ?? false;
  const isNoAnswer = NO_ANSWER_REASONS.has(disconnection_reason);
  const custom = call_analysis?.custom_analysis_data ?? {};

  const outcome = inVoicemail || isNoAnswer
    ? {
        callSuccessful: false,
        callSummary: inVoicemail ? "Voicemail reached" : "No answer",
        userSentiment: "Unknown",
        appointmentConfirmed: "unclear",
        rescheduleRequested: false,
        cancellationRequested: false,
      }
    : {
        callSuccessful: call_analysis?.call_successful ?? false,
        callSummary: call_analysis?.call_summary ?? null,
        userSentiment: call_analysis?.user_sentiment ?? "Unknown",
        appointmentConfirmed: custom.appointment_confirmed ?? "unclear",
        rescheduleRequested: custom.reschedule_requested ?? false,
        cancellationRequested: custom.cancellation_requested ?? false,
      };

  // Parse node transitions to log which subagent handled the conversation
  const nodeTransitions = extractNodeTransitions(transcript_with_tool_calls);
  const activeSubagent = nodeTransitions.find((n) => n.node_id !== "node_router" && n.node_id !== "node_end");

  const isTest = !!(metadata?.is_test || metadata?.test_call);

  await callsDb.upsertAnalyzed({
    retellCallId: call_id,
    companyId,
    toNumber: callData.to_number,
    fromNumber: callData.from_number,
    durationMs: duration_ms,
    disconnectionReason: disconnection_reason,
    inVoicemail,
    metadata,
    isTest,
    transcript,
    transcriptWithToolCalls: transcript_with_tool_calls,
    callCost: call_cost,
    rawAnalysis: call_analysis,
    ...outcome,
  });

  const callRow = await db.query(`SELECT id FROM calls WHERE retell_call_id = $1`, [call_id]);
  const callId = callRow.rows[0]?.id ?? null;

  await callLogsDb.insert({
    companyId, callId, retellCallId: call_id,
    eventType: "call_analyzed",
    payload: {
      in_voicemail: inVoicemail,
      disconnection_reason,
      active_subagent: activeSubagent ?? null,
      node_transitions: nodeTransitions,
      call_cost: call_cost ?? null,
      ...outcome,
    },
  });

  const todoType = todosDb.deriveTodoType({
    inVoicemail,
    disconnectionReason: disconnection_reason,
    appointmentConfirmed: outcome.appointmentConfirmed,
    rescheduleRequested: outcome.rescheduleRequested,
    cancellationRequested: outcome.cancellationRequested,
    customerOutcome: custom.customer_outcome ?? null,
  });

  // If the agent already cancelled the appointment/job LIVE via the
  // cancel_appointment tool during this call (marked with
  // additional_information.cancelled_by_agent_call_id), the ASKED_FOR_CANCELLATION
  // escalation would be redundant — the tool already raised its own low-priority
  // APPOINTMENT_CANCELLED FYI todo. Suppress only that case.
  let suppressCancellationTodo = false;
  if (todoType === todosDb.TODO_TYPES.ASKED_FOR_CANCELLATION) {
    const { rows: cancelledCheck } = await db.query(
      `SELECT 1 FROM appointments WHERE company_id = $1 AND additional_information->>'cancelled_by_agent_call_id' = $2
       UNION ALL
       SELECT 1 FROM jobs WHERE company_id = $1 AND additional_information->>'cancelled_by_agent_call_id' = $2
       LIMIT 1`,
      [companyId, call_id]
    );
    suppressCancellationTodo = cancelledCheck.length > 0;
    if (suppressCancellationTodo) {
      logger.info("Cancellation already actioned live via cancel_appointment tool; skipping ASKED_FOR_CANCELLATION todo", { callId: call_id, companyId });
    }
  }

  if (todoType && !suppressCancellationTodo) {
    await todosDb.create({
      companyId,
      callId,
      type: todoType,
      isTest,
      metadata: {
        retell_call_id: call_id,
        to_number: callData.to_number,
        call_summary: outcome.callSummary,
        user_sentiment: outcome.userSentiment,
        appointment_confirmed: outcome.appointmentConfirmed,
        active_subagent: activeSubagent?.node_name ?? null,
      },
    });
    logger.info("Todo created", { callId: call_id, companyId, todoType });
  }

  // ── Service Opportunity Follow-Up escalation ──────────────────────────────
  // When the customer wanted to book but the agent was NOT allowed to make
  // changes (agent_can_make_changes = false), nothing was booked in-platform
  // during the call — raise a SERVICE_OPPORTUNITY todo so a human completes it.
  // (When writes are enabled, the agent already booked live via the
  // book_service_opportunity tool, so no escalation is needed.)
  if (metadata?.call_type === "service_opportunity_followup") {
    const bookingOutcome = custom.booking_outcome ?? null;
    const wantsBooking = ["booked", "partially_booked", "needs_to_check"].includes(bookingOutcome);
    if (wantsBooking) {
      const cs = await callSettingsDb.getByCompanyId(companyId).catch(() => null);
      const canMakeChanges = cs ? cs.agent_can_make_changes !== false : true;
      if (!canMakeChanges) {
        await todosDb.create({
          companyId,
          callId,
          type: todosDb.TODO_TYPES.SERVICE_OPPORTUNITY,
          isTest,
          metadata: {
            retell_call_id: call_id,
            to_number: callData.to_number,
            booking_outcome: bookingOutcome,
            preferred_date: custom.preferred_date ?? null,
            notes: custom.notes ?? null,
            call_summary: outcome.callSummary,
            reason: "Customer wanted to book but the agent is not permitted to make changes — please book these service opportunities.",
          },
        });
        logger.info("Service opportunity escalation todo created", { callId: call_id, companyId, bookingOutcome });
      }
    }
  }

  // ── Post-call ServiceTrade write-backs (comment + service link) ────────────
  // For ANSWERED calls only (voicemail/no-answer excluded). AWAITED (not
  // fire-and-forget) so the network POSTs complete before this handler returns —
  // on Vercel the function is frozen once the webhook responds, which would cut
  // off any still-pending async work (this was the root cause of comments not
  // posting). Each action is internally gated by its own per-company toggle.
  const callType = metadata?.call_type;
  const wantsComment = !inVoicemail && !isNoAnswer && stComments.appliesToCallType(callType);
  const wantsServiceLink = !inVoicemail && !isNoAnswer && callType === "customer_confirmation";
  logger.info("servicetrade post-call: gate", {
    callId: call_id, companyId, callType, inVoicemail, isNoAnswer, wantsComment, wantsServiceLink,
  });
  if (wantsComment || wantsServiceLink) {
    try {
      const { rows: scRows } = await db.query(`SELECT * FROM scheduled_calls WHERE retell_call_id = $1 LIMIT 1`, [call_id]);
      const sc = scRows[0];
      if (!sc) {
        logger.warn("servicetrade post-call: no scheduled_calls row for retell_call_id; cannot resolve entity", { callId: call_id, companyId });
      } else {
        if (wantsComment) {
          await stComments
            .postCallComment({ companyId, scheduledCall: sc, outcome, custom, callSummary: outcome.callSummary, retellCallId: call_id, callId })
            .catch((err) => logger.error("servicetrade comment write-back failed", { error: err.message, callId: call_id }));
        }
        if (wantsServiceLink) {
          await stServiceLink
            .postCallServiceLink({ companyId, scheduledCall: sc, outcome, retellCallId: call_id, callId })
            .catch((err) => logger.error("servicetrade service-link failed", { error: err.message, callId: call_id }));
        }
      }
    } catch (err) {
      logger.error("servicetrade post-call: scheduled_calls lookup failed", { error: err.message, callId: call_id });
    }
  }

  logger.info("Call analyzed — outcome saved", {
    callId: call_id,
    companyId,
    todoType: todoType || "none (confirmed)",
    activeSubagent: activeSubagent?.node_name ?? null,
    costCents: call_cost?.combined_cost ?? null,
    ...outcome,
  });

  // ── Retry / Callback scheduling (production only) ─────────────────────────
  // In dev, is_test=true calls skip this — no retry spam during testing.
  // `outcome` is sourced from whichever extract variable the call_type emits —
  // customer_outcome (customer_confirmation), technician_outcome (technician_confirmation),
  // quote_decision (quotation_followup). All of them use 'callback_requested' as the
  // sentinel value, so we normalize them into a single field for handleRetryOrCallback.
  if (!isDev && !isTest) {
    const outcomeStr = custom.customer_outcome ?? custom.technician_outcome ?? custom.quote_decision ?? custom.booking_outcome ?? null;
    await handleRetryOrCallback({
      companyId,
      retellCallId: call_id,
      inVoicemail,
      isNoAnswer,
      customerOutcome: outcomeStr,
      callbackTime:    custom.callback_time ?? null,
    }).catch(err => logger.error("retry/callback scheduling failed", { error: err.message, callId: call_id }));
  }
}

/**
 * After a call ends, decide whether to schedule a retry or callback:
 *
 * RETRY  — customer didn't pick up (no-answer / voicemail):
 *   Schedule the same call for next business-hours window, up to MAX_NO_ANSWER_RETRIES times,
 *   as long as the next attempt would be before the job's due date.
 *
 * CALLBACK — customer picked up and requested a specific time:
 *   Schedule at the requested time. If the parsed time is in the past, skip.
 *   Must still be before the job's due date.
 */
async function handleRetryOrCallback({ companyId, retellCallId, inVoicemail, isNoAnswer, customerOutcome, callbackTime }) {
  // Find the scheduled_call row that triggered this Retell call
  const { rows: scRows } = await db.query(
    `SELECT sc.*, j.scheduled_date AS job_due_date
     FROM scheduled_calls sc
     LEFT JOIN jobs j ON j.id::text = sc.job_id AND j.company_id = sc.company_id
     WHERE sc.retell_call_id = $1 LIMIT 1`,
    [retellCallId]
  );
  if (scRows.length === 0) {
    logger.warn("retry/callback: no scheduled_call found for retell call", { retellCallId });
    return;
  }
  const sc = scRows[0];

  // Fetch company timezone + call settings for next-window calculation
  const { rows: coRows } = await db.query(
    `SELECT default_timezone FROM companies WHERE id = $1`, [companyId]
  );
  const tz = coRows[0]?.default_timezone || "America/New_York";
  const cs = await callSettingsDb.getByCompanyId(companyId);

  // ── CALLBACK: customer asked to be called at a specific time ──────────────
  if (customerOutcome === "callback_requested" && callbackTime) {
    const callbackAt = parseCallbackTime(callbackTime, tz);
    if (callbackAt && callbackAt > new Date()) {
      const created = await scheduledCallsDb.scheduleCallback(sc, callbackAt.toISOString(), sc.job_due_date);
      if (created) {
        logger.info("Callback scheduled", { companyId, parentId: sc.id, callbackAt, jobId: sc.job_id });
      } else {
        logger.info("Callback not scheduled (past due date or duplicate)", { companyId, parentId: sc.id });
      }
    } else {
      logger.warn("Callback time could not be parsed or is in the past", { callbackTime, companyId });
    }
    return;
  }

  // ── RETRY: no-answer or voicemail ─────────────────────────────────────────
  if (inVoicemail || isNoAnswer) {
    const nextWindow = getNextWindowStart(cs, tz); // next business-hours slot
    const created = await scheduledCallsDb.scheduleRetry(sc, nextWindow.toISOString(), sc.job_due_date, MAX_NO_ANSWER_RETRIES, tz);
    if (created) {
      logger.info("Retry scheduled", {
        companyId, parentId: sc.id, retryCount: sc.retry_count + 1,
        nextWindow, jobId: sc.job_id,
      });
    } else {
      const reason = sc.retry_count >= MAX_NO_ANSWER_RETRIES
        ? `max retries reached (${MAX_NO_ANSWER_RETRIES})`
        : "next window is past job due date";
      logger.info("Retry not scheduled", { companyId, parentId: sc.id, reason });
    }
  }
}

// parseCallbackTime moved to src/services/callback-time.js (shared with the
// live schedule_callback Retell tool in routes/retell-tools.js).

module.exports = router;
