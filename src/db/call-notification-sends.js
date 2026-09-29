/**
 * The notification queue AND the audit ledger — see migrations/107.
 *
 * One row per (conversation, recipient). The webhook enqueues; a cron sweep
 * (services/call-notification/drain.js) drains. The same row then stays as the
 * permanent record of where the email went and whether the audio made it.
 *
 * Why a queue at all: Retell types recording_url as optional and its S3 object
 * can lag the call_analyzed webhook. Fetching inline would cost the audio on
 * that email permanently; here a failed attempt just comes back round.
 */

const db = require("./index");
const logger = require("../utils/logger");

const STATUS = { PENDING: "pending", SENT: "sent", FAILED: "failed" };

function present(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    company_id: row.company_id,
    call_id: row.call_id,
    retell_call_id: row.retell_call_id,
    recipient_id: row.recipient_id,
    email: row.email,
    event: row.event,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    next_attempt_at: row.next_attempt_at,
    recording_attached: row.recording_attached,
    attachment_bytes: row.attachment_bytes,
    last_error: row.last_error,
    sent_at: row.sent_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Queue one email. ON CONFLICT DO NOTHING against the
 * (retell_call_id, LOWER(email)) unique index is the whole duplicate-email
 * guard: a Retell webhook replay re-runs this and inserts nothing.
 *
 * @returns {Promise<object|null>} the new row, or null if already queued/sent.
 */
async function enqueue({ companyId, callId = null, retellCallId, recipientId, email, event, channel = "voice" }) {
  const { rows } = await db.query(
    `INSERT INTO call_notification_sends
       (company_id, call_id, retell_call_id, recipient_id, email, event, channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (retell_call_id, LOWER(email)) DO NOTHING
     RETURNING *`,
    [companyId, callId, retellCallId, recipientId, String(email).trim().toLowerCase(), event, channel]
  );
  return present(rows[0]) || null;
}

/**
 * Claim every pending row that is due, oldest first.
 *
 * FOR UPDATE SKIP LOCKED matters: the drain runs on a one-minute cron, and a
 * slow pass can still be holding rows when the next invocation starts. Without
 * SKIP LOCKED the second pass would block on, then re-send, the same rows.
 * `attempts` is bumped inside the same statement so a crash mid-pass still
 * spends an attempt rather than looping forever on a poisoned row.
 */
async function claimDueBatch(limit = 50, now = new Date()) {
  const { rows } = await db.query(
    `WITH due AS (
       SELECT id FROM call_notification_sends
        WHERE status = 'pending' AND next_attempt_at <= $2
        ORDER BY next_attempt_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE call_notification_sends s
        SET attempts = s.attempts + 1, updated_at = now()
       FROM due
      WHERE s.id = due.id
      RETURNING s.*`,
    [limit, now]
  );
  return rows.map(present);
}

async function markSent(id, { recordingAttached = null, attachmentBytes = null } = {}) {
  await db.query(
    `UPDATE call_notification_sends
        SET status = 'sent', sent_at = now(), last_error = NULL,
            recording_attached = $2, attachment_bytes = $3, updated_at = now()
      WHERE id = $1`,
    [id, recordingAttached, attachmentBytes]
  );
}

/** Leave it pending and come back later — used when the recording is not ready yet. */
async function markRetry(id, { nextAttemptAt, error = null }) {
  await db.query(
    `UPDATE call_notification_sends
        SET next_attempt_at = $2, last_error = $3, updated_at = now()
      WHERE id = $1`,
    [id, nextAttemptAt, error ? String(error).slice(0, 1000) : null]
  );
}

/** Give up permanently — the send itself kept failing, not just the audio fetch. */
async function markFailed(id, error) {
  await db.query(
    `UPDATE call_notification_sends
        SET status = 'failed', last_error = $2, updated_at = now()
      WHERE id = $1`,
    [id, error ? String(error).slice(0, 1000) : null]
  );
}

/** Never throws — a bookkeeping failure must not mask the send it describes. */
async function markSentSafe(id, opts) {
  try { await markSent(id, opts); } catch (err) {
    logger.warn("call notification: failed to stamp sent", { id, error: err.message });
  }
}

/** This conversation's delivery history, newest first. */
async function listForCall(companyId, retellCallId) {
  const { rows } = await db.query(
    `SELECT * FROM call_notification_sends
      WHERE company_id = $1 AND retell_call_id = $2
      ORDER BY created_at DESC`,
    [companyId, retellCallId]
  );
  return rows.map(present);
}

module.exports = {
  STATUS, enqueue, claimDueBatch, markSent, markSentSafe, markRetry, markFailed, listForCall,
};
