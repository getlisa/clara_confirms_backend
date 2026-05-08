const db = require("./index");

/**
 * Upsert a stub record when a call ends.
 * Uses ON CONFLICT DO NOTHING so a subsequent call_analyzed upsert wins.
 */
async function upsertStub({ retellCallId, companyId, toNumber, fromNumber, durationMs, disconnectionReason, inVoicemail, metadata }) {
  await db.query(
    `INSERT INTO calls
       (retell_call_id, company_id, to_number, from_number, duration_ms,
        disconnection_reason, in_voicemail, metadata, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ended')
     ON CONFLICT (retell_call_id) DO UPDATE SET
       duration_ms          = COALESCE(EXCLUDED.duration_ms, calls.duration_ms),
       disconnection_reason = COALESCE(EXCLUDED.disconnection_reason, calls.disconnection_reason),
       in_voicemail         = COALESCE(EXCLUDED.in_voicemail, calls.in_voicemail),
       metadata             = COALESCE(EXCLUDED.metadata, calls.metadata),
       updated_at           = NOW()`,
    [retellCallId, companyId, toNumber, fromNumber, durationMs, disconnectionReason, inVoicemail, metadata ? JSON.stringify(metadata) : null]
  );
}

/**
 * Upsert the full analyzed record.
 */
async function upsertAnalyzed({
  retellCallId, companyId, toNumber, fromNumber,
  durationMs, disconnectionReason, inVoicemail, metadata,
  callSuccessful, callSummary, userSentiment,
  appointmentConfirmed, rescheduleRequested, cancellationRequested,
  transcript, rawAnalysis,
}) {
  await db.query(
    `INSERT INTO calls
       (retell_call_id, company_id, to_number, from_number, duration_ms,
        disconnection_reason, in_voicemail, metadata, status,
        call_successful, call_summary, user_sentiment,
        appointment_confirmed, reschedule_requested, cancellation_requested,
        transcript, raw_analysis)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'analyzed',$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (retell_call_id) DO UPDATE SET
       status                 = 'analyzed',
       duration_ms            = COALESCE(EXCLUDED.duration_ms, calls.duration_ms),
       disconnection_reason   = COALESCE(EXCLUDED.disconnection_reason, calls.disconnection_reason),
       in_voicemail           = COALESCE(EXCLUDED.in_voicemail, calls.in_voicemail),
       metadata               = COALESCE(EXCLUDED.metadata, calls.metadata),
       call_successful        = EXCLUDED.call_successful,
       call_summary           = EXCLUDED.call_summary,
       user_sentiment         = EXCLUDED.user_sentiment,
       appointment_confirmed  = EXCLUDED.appointment_confirmed,
       reschedule_requested   = EXCLUDED.reschedule_requested,
       cancellation_requested = EXCLUDED.cancellation_requested,
       transcript             = EXCLUDED.transcript,
       raw_analysis           = EXCLUDED.raw_analysis,
       updated_at             = NOW()`,
    [
      retellCallId, companyId, toNumber, fromNumber, durationMs,
      disconnectionReason, inVoicemail, metadata ? JSON.stringify(metadata) : null,
      callSuccessful, callSummary, userSentiment,
      appointmentConfirmed, rescheduleRequested, cancellationRequested,
      transcript ? JSON.stringify(transcript) : null,
      rawAnalysis ? JSON.stringify(rawAnalysis) : null,
    ]
  );
}

async function list(companyId, { limit = 50, offset = 0, status, appointmentConfirmed } = {}) {
  const conditions = ["company_id = $1"];
  const values = [companyId];
  let i = 2;

  if (status) { conditions.push(`status = $${i++}`); values.push(status); }
  if (appointmentConfirmed) { conditions.push(`appointment_confirmed = $${i++}`); values.push(appointmentConfirmed); }

  values.push(limit, offset);
  const result = await db.query(
    `SELECT id, retell_call_id, to_number, from_number, direction, status,
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
