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
  recordingUrl = null, publicLogUrl = null,
}) {
  await db.query(
    `INSERT INTO calls
       (retell_call_id, company_id, to_number, from_number, duration_ms,
        disconnection_reason, in_voicemail, metadata, status, is_test,
        call_successful, call_summary, user_sentiment,
        appointment_confirmed, reschedule_requested, cancellation_requested,
        transcript, transcript_with_tool_calls, call_cost, raw_analysis, channel,
        recording_url, public_log_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'analyzed',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
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
       -- COALESCE, not EXCLUDED: Retell types recording_url as optional and the
       -- S3 object can lag this webhook, so a redelivery that arrives WITHOUT
       -- the field must not blank a URL we already captured.
       recording_url               = COALESCE(EXCLUDED.recording_url, calls.recording_url),
       public_log_url              = COALESCE(EXCLUDED.public_log_url, calls.public_log_url),
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
      recordingUrl || null,
      publicLogUrl || null,
    ]
  );
}

/**
 * The recording URL for one call — read ONLY by the backend (the notification
 * email's audio fetch and the GET /calls/:id/recording proxy). Deliberately not
 * part of rowToCall: it is an unauthenticated link to a customer conversation,
 * so it must never reach an email body or a browser. See migration 107.
 */
async function getRecordingUrl(id, companyId) {
  const { rows } = await db.query(
    `SELECT recording_url FROM calls WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  return rows[0]?.recording_url ?? null;
}

/**
 * Everything GET /calls/:id/recording needs to serve the audio: our own object
 * first, Retell's URL as the fallback, and whether it was deliberately purged
 * (so the route can answer "gone for good" rather than a bare 404).
 */
async function getRecordingSource(id, companyId) {
  const { rows } = await db.query(
    `SELECT recording_storage_path, recording_url, recording_purged_at, recording_content_type
       FROM calls WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    storagePath: row.recording_storage_path ?? null,
    retellUrl: row.recording_url ?? null,
    purgedAt: row.recording_purged_at ?? null,
    contentType: row.recording_content_type ?? null,
  };
}

/** Same, keyed by Retell's id — what the notification drain has in hand. */
async function getRecordingSourceByRetellId(retellCallId) {
  const { rows } = await db.query(
    `SELECT recording_storage_path, recording_url, recording_purged_at, recording_content_type
       FROM calls WHERE retell_call_id = $1`,
    [retellCallId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    storagePath: row.recording_storage_path ?? null,
    retellUrl: row.recording_url ?? null,
    purgedAt: row.recording_purged_at ?? null,
    contentType: row.recording_content_type ?? null,
  };
}

/** Same, keyed by Retell's id — what the notification drain has in hand. */
async function getRecordingUrlByRetellId(retellCallId) {
  const { rows } = await db.query(
    `SELECT recording_url FROM calls WHERE retell_call_id = $1`,
    [retellCallId]
  );
  return rows[0]?.recording_url ?? null;
}

async function setRecordingUrl(retellCallId, recordingUrl) {
  await db.query(
    `UPDATE calls SET recording_url = $2, updated_at = NOW() WHERE retell_call_id = $1`,
    [retellCallId, recordingUrl]
  );
}

/**
 * Free-text search across the four fields the Logs page advertises: recipient
 * phone, email, location name, customer name.
 *
 * Phone is matched DIGITS-ONLY on both sides. Stored numbers are genuinely
 * inconsistent — `+19402324304` and `(402) 620-5042` both exist in real data —
 * so a plain ILIKE misses whichever format the user did not type.
 *
 * @returns {{clause: string, values: any[]}} clause already parameterised from `startIndex`
 */
function searchClause(search, startIndex, { phoneExpr, textExprs }) {
  const digits = String(search).replace(/\D/g, "");
  const like = `%${search}%`;
  const values = [like];
  let i = startIndex;
  const parts = textExprs.map((e) => `${e} ILIKE $${i}`);
  i += 1;
  if (digits) {
    values.push(`%${digits}%`);
    parts.push(`regexp_replace(COALESCE(${phoneExpr}, ''), '\\D', '', 'g') LIKE $${i}`);
  }
  return { clause: `(${parts.join(" OR ")})`, values };
}

async function list(companyId, { limit = 50, offset = 0, status, appointmentConfirmed, isTest = false, search = null } = {}) {
  // Prefix every column with `c.` since we now JOIN customers + scheduled_calls
  const conditions = ["c.company_id = $1", "c.is_test = $2"];
  const values = [companyId, isTest];
  let i = 3;

  if (status) { conditions.push(`c.status = $${i++}`); values.push(status); }
  if (appointmentConfirmed) { conditions.push(`c.appointment_confirmed = $${i++}`); values.push(appointmentConfirmed); }
  if (search && String(search).trim()) {
    const { clause, values: sv } = searchClause(String(search).trim(), i, {
      phoneExpr: "c.to_number",
      textExprs: ["cu.full_name", "cu.email", "l.name"],
    });
    conditions.push(clause);
    values.push(...sv);
    i += sv.length;
  }

  values.push(limit, offset);
  const result = await db.query(
    `SELECT c.id, c.retell_call_id, c.to_number, c.from_number, c.direction, c.status, c.is_test,
            c.duration_ms, c.disconnection_reason, c.in_voicemail, c.channel,
            c.call_successful, c.call_summary, c.user_sentiment,
            c.appointment_confirmed, c.reschedule_requested, c.cancellation_requested,
            c.transcript, c.recording_url, c.recording_storage_path,
            c.recording_purged_at, c.recording_bytes, c.recording_archive_attempts,
            c.created_at, c.updated_at,
            cu.id          AS customer_id,
            cu.full_name   AS customer_name,
            cu.email       AS customer_email,
            cu.address_line1, cu.city, cu.state, cu.zipcode,
            sc.call_type, sc.job_id, sc.job_name, sc.appointment_id,
            sc.origin, sc.triggered_by_user_id, sc.triggered_by_name,
            l.name AS location_name
     FROM calls c
     LEFT JOIN customers cu
       ON cu.company_id = c.company_id AND cu.phone = c.to_number
     LEFT JOIN scheduled_calls sc
       ON sc.retell_call_id = c.retell_call_id
     -- scheduled_calls.job_id is VARCHAR while jobs.id is INTEGER, and it can
     -- hold non-numeric ids (the manual/test paths use string refs). Stripping
     -- to digits and NULLIF-ing the empty result means the cast is only ever
     -- applied to something castable — a bare sc.job_id::int throws on the
     -- first TEST-SO-1 row it meets.
     LEFT JOIN jobs j
       ON j.company_id = c.company_id
      AND j.id = NULLIF(regexp_replace(COALESCE(sc.job_id, ''), '[^0-9]', '', 'g'), '')::int
     LEFT JOIN locations l ON l.id = j.location_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY c.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return result.rows.map(rowToCall);
}

/**
 * Derive the recording's lifecycle state. Order matters: a purged recording may
 * still carry Retell's URL, and that URL must NOT make it look available again
 * — we deleted our copy on purpose, and Retell's own retention is not something
 * this product promises anything about.
 */
function recordingState(row) {
  if (row.recording_purged_at) return "purged";
  if (row.recording_storage_path) return "available";
  if (row.recording_url) return "available";
  if ((row.channel ?? "voice") === "voice" && row.status === "analyzed") return "pending";
  return "none";
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
    // A boolean, never the URL itself — see getRecordingUrl. The portal plays
    // it through GET /calls/:id/recording instead.
    has_recording:           recordingState(row) === "available",
    // WHY a state and not just the boolean: with a retention window, "no audio"
    // has two very different meanings the UI must not conflate — not archived
    // YET (comes back on its own) versus deleted at end of retention (never
    // comes back). A bare boolean would render both as a broken player.
    //   available — playable right now
    //   pending   — voice call whose audio has not been captured yet
    //   purged    — deleted after the retention window; permanently gone
    //   none      — no recording exists (a chat, or a call that never had one)
    recording_state:         recordingState(row),
    // Where a playable recording would be served from. Ops/debug only — the
    // player uses recording_stream_url regardless.
    recording_source:        row.recording_storage_path ? "archive" : (row.recording_url ? "retell" : null),
    recording_bytes:         row.recording_bytes != null ? Number(row.recording_bytes) : null,
    location_name:           row.location_name ?? null,
    // Manual vs swept, and who clicked. A manually-dialled call and a
    // scheduler-dialled one were indistinguishable in the logs before this.
    origin:                  row.origin ?? null,
    triggered_by_user_id:    row.triggered_by_user_id ?? null,
    triggered_by_name:       row.triggered_by_name ?? null,
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
            sc.call_type, sc.job_id, sc.job_name, sc.appointment_id,
            l.name AS location_name
     FROM calls c
     LEFT JOIN customers cu
       ON cu.company_id = c.company_id AND cu.phone = c.to_number
     LEFT JOIN scheduled_calls sc
       ON sc.retell_call_id = c.retell_call_id
     -- The same jobs -> locations hop list() does, and for the same reason:
     -- the site name is usually the ONLY human-readable identity a call has.
     -- The customers join above matches on phone and misses constantly (both
     -- of the calls that prompted this had customer_name NULL but a real
     -- location), and InspectPoint links work to a BUILDING with no Account at
     -- all. Without this join getById returned location_name undefined, so the
     -- notification email fell through to the raw phone number.
     --
     -- scheduled_calls.job_id is VARCHAR and can hold non-numeric refs like
     -- TEST-SO-1, so it is stripped to digits and NULLIF-ed before the cast —
     -- a bare sc.job_id::int throws on the first such row.
     LEFT JOIN jobs j
       ON j.company_id = c.company_id
      AND j.id = NULLIF(regexp_replace(COALESCE(sc.job_id, ''), '[^0-9]', '', 'g'), '')::int
     LEFT JOIN locations l ON l.id = j.location_id
     WHERE c.id = $1 AND c.company_id = $2`,
    [id, companyId]
  );
  return result.rows[0] ? rowToCall(result.rows[0]) : null;
}

module.exports = {
  searchClause, upsertStub, upsertAnalyzed, list, getById,
  getRecordingUrl, getRecordingUrlByRetellId, setRecordingUrl,
  getRecordingSource, getRecordingSourceByRetellId, recordingState };
