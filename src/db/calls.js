const db = require("./index");

async function upsertStub({ retellCallId, companyId, toNumber, fromNumber, durationMs, disconnectionReason, inVoicemail, metadata, isTest = false }) {
  await db.query(
    `INSERT INTO calls
       (retell_call_id, company_id, to_number, from_number, duration_ms,
        disconnection_reason, in_voicemail, metadata, status, is_test)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ended', $9)
     ON CONFLICT (retell_call_id) DO UPDATE SET
       duration_ms          = COALESCE(EXCLUDED.duration_ms, calls.duration_ms),
       disconnection_reason = COALESCE(EXCLUDED.disconnection_reason, calls.disconnection_reason),
       in_voicemail         = COALESCE(EXCLUDED.in_voicemail, calls.in_voicemail),
       metadata             = COALESCE(EXCLUDED.metadata, calls.metadata),
       is_test              = EXCLUDED.is_test,
       updated_at           = NOW()`,
    [retellCallId, companyId, toNumber, fromNumber, durationMs, disconnectionReason, inVoicemail, metadata ? JSON.stringify(metadata) : null, isTest]
  );
}

async function upsertAnalyzed({
  retellCallId, companyId, toNumber, fromNumber,
  durationMs, disconnectionReason, inVoicemail, metadata, isTest = false,
  callSuccessful, callSummary, userSentiment,
  appointmentConfirmed, rescheduleRequested, cancellationRequested,
  transcript, transcriptWithToolCalls, callCost, rawAnalysis,
}) {
  await db.query(
    `INSERT INTO calls
       (retell_call_id, company_id, to_number, from_number, duration_ms,
        disconnection_reason, in_voicemail, metadata, status, is_test,
        call_successful, call_summary, user_sentiment,
        appointment_confirmed, reschedule_requested, cancellation_requested,
        transcript, transcript_with_tool_calls, call_cost, raw_analysis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'analyzed',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (retell_call_id) DO UPDATE SET
       status                      = 'analyzed',
       duration_ms                 = COALESCE(EXCLUDED.duration_ms, calls.duration_ms),
       disconnection_reason        = COALESCE(EXCLUDED.disconnection_reason, calls.disconnection_reason),
       in_voicemail                = COALESCE(EXCLUDED.in_voicemail, calls.in_voicemail),
       metadata                    = COALESCE(EXCLUDED.metadata, calls.metadata),
       is_test                     = EXCLUDED.is_test,
       call_successful             = EXCLUDED.call_successful,
       call_summary                = EXCLUDED.call_summary,
       user_sentiment              = EXCLUDED.user_sentiment,
       appointment_confirmed       = EXCLUDED.appointment_confirmed,
       reschedule_requested        = EXCLUDED.reschedule_requested,
       cancellation_requested      = EXCLUDED.cancellation_requested,
       transcript                  = EXCLUDED.transcript,
       transcript_with_tool_calls  = EXCLUDED.transcript_with_tool_calls,
       call_cost                   = EXCLUDED.call_cost,
       raw_analysis                = EXCLUDED.raw_analysis,
       updated_at                  = NOW()`,
    [
      retellCallId, companyId, toNumber, fromNumber, durationMs,
      disconnectionReason, inVoicemail, metadata ? JSON.stringify(metadata) : null, isTest,
      callSuccessful, callSummary, userSentiment,
      appointmentConfirmed, rescheduleRequested, cancellationRequested,
      transcript ? JSON.stringify(transcript) : null,
      transcriptWithToolCalls ? JSON.stringify(transcriptWithToolCalls) : null,
      callCost ? JSON.stringify(callCost) : null,
      rawAnalysis ? JSON.stringify(rawAnalysis) : null,
    ]
  );
}

async function list(companyId, { limit = 50, offset = 0, status, appointmentConfirmed, isTest = false } = {}) {
  const conditions = ["company_id = $1", "is_test = $2"];
  const values = [companyId, isTest];
  let i = 3;

  if (status) { conditions.push(`status = $${i++}`); values.push(status); }
  if (appointmentConfirmed) { conditions.push(`appointment_confirmed = $${i++}`); values.push(appointmentConfirmed); }

  values.push(limit, offset);
  const result = await db.query(
    `SELECT id, to_number, from_number, direction, status, is_test,
            duration_ms, disconnection_reason, in_voicemail,
            call_successful, call_summary, user_sentiment,
            appointment_confirmed, reschedule_requested, cancellation_requested,
            transcript, created_at, updated_at
     FROM calls
     WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return result.rows;
}

async function getById(id, companyId) {
  const result = await db.query(
    `SELECT * FROM calls WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  return result.rows[0] ?? null;
}

module.exports = { upsertStub, upsertAnalyzed, list, getById };
