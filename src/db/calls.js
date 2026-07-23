const db = require("./index");

async function upsertStub({ retellCallId, companyId, toNumber, fromNumber, durationMs, disconnectionReason, inVoicemail, metadata, isTest = false, channel = "voice" }) {
  await db.query(
    `INSERT INTO calls
       (retell_call_id, company_id, to_number, from_number, duration_ms,
        disconnection_reason, in_voicemail, metadata, status, is_test, channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ended', $9, $10)
     ON CONFLICT (retell_call_id) DO UPDATE SET
       duration_ms          = COALESCE(EXCLUDED.duration_ms, calls.duration_ms),
       disconnection_reason = COALESCE(EXCLUDED.disconnection_reason, calls.disconnection_reason),
       in_voicemail         = COALESCE(EXCLUDED.in_voicemail, calls.in_voicemail),
       metadata             = COALESCE(EXCLUDED.metadata, calls.metadata),
       is_test              = EXCLUDED.is_test,
       channel              = EXCLUDED.channel,
       updated_at           = NOW()`,
    [retellCallId, companyId, toNumber, fromNumber, durationMs, disconnectionReason, inVoicemail, metadata ? JSON.stringify(metadata) : null, isTest, channel || "voice"]
  );
}

async function upsertAnalyzed({
  retellCallId, companyId, toNumber, fromNumber,
  durationMs, disconnectionReason, inVoicemail, metadata, isTest = false,
  callSuccessful, callSummary, userSentiment,
  appointmentConfirmed, rescheduleRequested, cancellationRequested,
  transcript, transcriptWithToolCalls, callCost, rawAnalysis, channel = "voice",
}) {
  await db.query(
    `INSERT INTO calls
       (retell_call_id, company_id, to_number, from_number, duration_ms,
        disconnection_reason, in_voicemail, metadata, status, is_test,
        call_successful, call_summary, user_sentiment,
        appointment_confirmed, reschedule_requested, cancellation_requested,
        transcript, transcript_with_tool_calls, call_cost, raw_analysis, channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'analyzed',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
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
       channel                     = EXCLUDED.channel,
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
      channel || "voice",
    ]
  );
}

async function list(companyId, { limit = 50, offset = 0, status, appointmentConfirmed, isTest = false } = {}) {
  // Prefix every column with `c.` since we now JOIN customers + scheduled_calls
  const conditions = ["c.company_id = $1", "c.is_test = $2"];
  const values = [companyId, isTest];
  let i = 3;

  if (status) { conditions.push(`c.status = $${i++}`); values.push(status); }
  if (appointmentConfirmed) { conditions.push(`c.appointment_confirmed = $${i++}`); values.push(appointmentConfirmed); }

  values.push(limit, offset);
  const result = await db.query(
    `SELECT c.id, c.retell_call_id, c.to_number, c.from_number, c.direction, c.status, c.is_test,
            c.duration_ms, c.disconnection_reason, c.in_voicemail, c.channel,
            c.call_successful, c.call_summary, c.user_sentiment,
            c.appointment_confirmed, c.reschedule_requested, c.cancellation_requested,
            c.transcript, c.created_at, c.updated_at,
            cu.id          AS customer_id,
            cu.full_name   AS customer_name,
            cu.email       AS customer_email,
            cu.address_line1, cu.city, cu.state, cu.zipcode,
            sc.call_type, sc.job_id, sc.job_name, sc.appointment_id
     FROM calls c
     LEFT JOIN customers cu
       ON cu.company_id = c.company_id AND cu.phone = c.to_number
     LEFT JOIN scheduled_calls sc
       ON sc.retell_call_id = c.retell_call_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return result.rows.map(rowToCall);
}

function rowToCall(row) {
  const customerAddress = [row.address_line1, row.city, row.state, row.zipcode].filter(Boolean).join(", ") || null;
  return {
    id:                      row.id,
    retell_call_id:          row.retell_call_id,
    to_number:               row.to_number,
    from_number:             row.from_number,
    direction:               row.direction,
    status:                  row.status,
    is_test:                 row.is_test,
    channel:                 row.channel ?? "voice",
    duration_ms:             row.duration_ms,
    disconnection_reason:    row.disconnection_reason,
    in_voicemail:            row.in_voicemail,
    call_successful:         row.call_successful,
    call_summary:            row.call_summary,
    user_sentiment:          row.user_sentiment,
    appointment_confirmed:   row.appointment_confirmed,
    reschedule_requested:    row.reschedule_requested,
    cancellation_requested:  row.cancellation_requested,
    transcript:              row.transcript,
    created_at:              row.created_at,
    updated_at:              row.updated_at,
    // Joined customer details
    customer: row.customer_id ? {
      id:      row.customer_id,
      name:    row.customer_name,
      phone:   row.to_number,
      email:   row.customer_email,
      address: customerAddress,
    } : null,
    // Joined call context (only present for scheduled/dispatched calls)
    call_type:      row.call_type ?? null,
    job_id:         row.job_id ?? null,
    job_name:       row.job_name ?? null,
    appointment_id: row.appointment_id ?? null,
  };
}

async function getById(id, companyId) {
  const result = await db.query(
    `SELECT c.*,
            cu.id          AS customer_id,
            cu.full_name   AS customer_name,
            cu.email       AS customer_email,
            cu.address_line1, cu.city, cu.state, cu.zipcode,
            sc.call_type, sc.job_id, sc.job_name, sc.appointment_id
     FROM calls c
     LEFT JOIN customers cu
       ON cu.company_id = c.company_id AND cu.phone = c.to_number
     LEFT JOIN scheduled_calls sc
       ON sc.retell_call_id = c.retell_call_id
     WHERE c.id = $1 AND c.company_id = $2`,
    [id, companyId]
  );
  return result.rows[0] ? rowToCall(result.rows[0]) : null;
}

module.exports = { upsertStub, upsertAnalyzed, list, getById };
