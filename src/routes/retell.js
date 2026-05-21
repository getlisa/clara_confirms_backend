const express = require("express");
const { verifyWebhookSignature } = require("../services/retell");
const callsDb = require("../db/calls");
const callLogsDb = require("../db/call-logs");
const todosDb = require("../db/todos");
const db = require("../db");
const logger = require("../utils/logger");

const router = express.Router();

// Raw body capture for webhook signature verification — before express.json()
router.use((req, res, next) => {
  let data = "";
  req.on("data", (chunk) => { data += chunk; });
  req.on("end", () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data || "{}"); } catch { req.body = {}; }
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

  const valid = await verifyWebhookSignature(req.rawBody, signature);
  if (!valid) {
    logger.warn("Retell webhook: invalid signature");
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.body;
  const eventType = event?.event;
  const callData = event?.call;   // Retell webhook payload: { event, call, event_timestamp }

  // Log full payload shape on first few events to verify structure
  logger.info("Retell webhook received", {
    eventType,
    callId: callData?.call_id,
    topLevelKeys: Object.keys(event || {}),
    hasData: !!callData,
  });

  if (eventType === "call_ended") {
    handleCallEnded(callData).catch((err) =>
      logger.error("call_ended handler failed", { error: err.message, callId: callData?.call_id })
    );
    return res.sendStatus(204);
  }

  if (eventType === "call_analyzed") {
    handleCallAnalyzed(callData).catch((err) =>
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
  });

  if (todoType) {
    await todosDb.create({
      companyId,
      callId,
      type: todoType,
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

  logger.info("Call analyzed — outcome saved", {
    callId: call_id,
    companyId,
    todoType: todoType || "none (confirmed)",
    activeSubagent: activeSubagent?.node_name ?? null,
    costCents: call_cost?.combined_cost ?? null,
    ...outcome,
  });
}

module.exports = router;
