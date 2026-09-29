/**
 * Stage 2: drain the notification queue — fetch each conversation's recording
 * once, then email every recipient waiting on it.
 *
 * Triggered by POST /admin/call-notifications/drain on a one-minute cron.
 * Isolation is the property that matters, exactly as in
 * services/daily-report/send.js's runSweep: one unreachable recording or one
 * bad address must never stop the rest of the batch.
 */

const db = require("../../db");
const callsDb = require("../../db/calls");
const sendsDb = require("../../db/call-notification-sends");
const { sendMail } = require("../../utils/email");
const { getCompanyTimezone, formatSpokenDateTime } = require("../../utils/timezone");
const logger = require("../../utils/logger");
const { fetchRecording, lookupRecordingUrl } = require("./recording");
const { buildNotificationEmail, buildPortalUrl } = require("./email");
const { PREFIX, maskEmail, since } = require("./log");

const BATCH_SIZE = Number(process.env.CALL_NOTIFICATION_BATCH_SIZE) || 50;

// How many passes the audio gets before the email goes out without it. The
// backoff below spans roughly half an hour, which is far longer than Retell has
// ever needed to attach a recording — but the email is never held hostage to it.
const RECORDING_MAX_ATTEMPTS = Number(process.env.RECORDING_MAX_ATTEMPTS) || 5;
// Attempt N waits BACKOFF_MINUTES[N-1] before the next try.
const BACKOFF_MINUTES = [1, 2, 4, 8, 16];

// Separately budgeted: this counts SendGrid itself failing, which is a
// different fault from the recording not being ready.
const SEND_MAX_ATTEMPTS = Number(process.env.CALL_NOTIFICATION_SEND_MAX_ATTEMPTS) || 5;

function nextAttemptAt(attempts, now) {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1] || 16;
  return new Date(now.getTime() + minutes * 60 * 1000);
}

/**
 * Everything the email needs about one conversation, fetched once per
 * conversation rather than once per recipient.
 */
async function loadContext(companyId, retellCallId) {
  const { rows } = await db.query(`SELECT id FROM calls WHERE retell_call_id = $1 AND company_id = $2`,
    [retellCallId, companyId]);
  const callId = rows[0]?.id;
  if (!callId) {
    logger.warn(`${PREFIX} drain   2/6 — call row not found`, { companyId, retellCallId });
    return null;
  }

  const [call, companyRows, tz] = await Promise.all([
    callsDb.getById(callId, companyId),
    db.query(`SELECT name FROM companies WHERE id = $1`, [companyId]),
    getCompanyTimezone(companyId),
  ]);
  if (!call) {
    logger.warn(`${PREFIX} drain   2/6 — call row vanished between reads`, { companyId, retellCallId, callId });
    return null;
  }

  logger.info(`${PREFIX} drain   2/6 — call context loaded`, {
    retellCallId, callId, channel: call.channel || "voice",
    customer: call.customer?.name || call.location_name || null,
    hasRecordingUrl: !!call.has_recording,
    hasTranscript: !!call.transcript,
    hasSummary: !!call.call_summary,
    tz,
  });

  return {
    call,
    callId,
    companyName: companyRows.rows[0]?.name || "Your company",
    whenLabel: call.created_at ? formatSpokenDateTime(call.created_at, tz) : null,
  };
}

/**
 * Resolve the audio for one conversation.
 *
 * Returns `{ recording, holdFor }`. A non-null `holdFor` means: do not send
 * yet, come back later — the recording is transiently unavailable and the rows
 * still have attempts left.
 */
async function resolveRecording({ call, retellCallId, minAttempts, isChat }) {
  if (isChat) {
    logger.info(`${PREFIX} drain   3/6 — chat conversation, no recording expected`, { retellCallId });
    return { recording: null, holdFor: null }; // not a degraded case
  }

  logger.info(`${PREFIX} drain   3/6 — resolving recording`, {
    retellCallId, attempt: minAttempts, maxAttempts: RECORDING_MAX_ATTEMPTS,
  });

  // Prefer OUR archived copy: it saves a second trip to Retell, and once a call
  // is archived the email no longer depends on Retell at all. Falls through to
  // the Retell path below when the archive sweep has not caught up yet.
  const src = await callsDb.getRecordingSourceByRetellId(retellCallId);
  if (src?.storagePath) {
    const fromArchive = await readArchived(src);
    if (fromArchive) {
      logger.info(`${PREFIX} drain   3/6 — recording read from our archive`, {
        retellCallId, objectPath: src.storagePath,
        kb: Math.round(fromArchive.bytes / 1024), contentType: fromArchive.contentType,
      });
      return { recording: fromArchive, holdFor: null };
    }
    logger.warn(`${PREFIX} drain   3/6 — archived copy unreadable, falling back to Retell`, {
      retellCallId, objectPath: src.storagePath,
    });
  }

  // Purged under the retention policy: there is nothing to wait for, and the
  // email must not stall. Send it with transcript + summary and say so.
  if (src?.purgedAt && !src?.storagePath) {
    logger.warn(`${PREFIX} drain   3/6 — recording was purged under retention; sending without audio`, {
      retellCallId, purgedAt: src.purgedAt,
    });
    return {
      recording: { status: "purged", buffer: null, contentType: null, ext: null, bytes: null,
                   reason: "The recording was deleted under the retention policy" },
      holdFor: null,
    };
  }

  let url = await callsDb.getRecordingUrlByRetellId(retellCallId);
  let urlSource = url ? "stored on the call row" : null;

  // The webhook may have analysed the call before Retell attached its
  // recording. Ask Retell directly, and keep what we learn.
  if (!url) {
    url = await lookupRecordingUrl(retellCallId);
    if (url) {
      urlSource = "fetched from Retell just now";
      await callsDb.setRecordingUrl(retellCallId, url)
        .then(() => logger.info(`${PREFIX} recording   → stored the late URL on the call row`, { retellCallId }))
        .catch((err) => logger.warn(`${PREFIX} recording   → could not persist late recording URL`, {
          retellCallId, error: err.message }));
    }
  }
  if (url) logger.info(`${PREFIX} drain   3/6 — recording URL source: ${urlSource}`, { retellCallId });

  const recording = await fetchRecording(url);

  // Only "unavailable" is worth waiting on. too_large and bad_type will not
  // improve by trying again, so those send immediately, without audio.
  if (recording.status === "unavailable" && minAttempts < RECORDING_MAX_ATTEMPTS) {
    return { recording, holdFor: recording.reason };
  }

  if (recording.status === "ok") {
    logger.info(`${PREFIX} drain   3/6 — recording ready to attach`, {
      retellCallId, bytes: recording.bytes, kb: Math.round(recording.bytes / 1024),
      contentType: recording.contentType,
    });
  } else {
    const permanent = recording.status !== "unavailable";
    logger.warn(`${PREFIX} drain   3/6 — SENDING WITHOUT AUDIO (${permanent ? "permanent for this call" : "retry budget spent"})`, {
      retellCallId, status: recording.status, reason: recording.reason,
      attempt: minAttempts, maxAttempts: RECORDING_MAX_ATTEMPTS,
    });
  }
  return { recording, holdFor: null };
}

/**
 * Read an archived object into the shape fetchRecording returns, so the email
 * builder cannot tell the two sources apart.
 * Returns null on any problem — the caller then falls back to Retell.
 */
async function readArchived(src) {
  try {
    const { openRecording } = require("../call-recording-archive");
    const { source, response } = await openRecording({ storagePath: src.storagePath, retellUrl: null });
    if (source !== "archive" || !response) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return null;
    const contentType = src.contentType || response.headers.get("content-type") || "audio/wav";
    const ext = (src.storagePath.split(".").pop() || "wav").toLowerCase();
    return { status: "ok", buffer, contentType, ext, bytes: buffer.length, reason: null };
  } catch (err) {
    logger.warn(`${PREFIX} drain       → reading archived copy threw`, { error: err.message });
    return null;
  }
}

/** Send one queued row. Never throws — the caller tallies the result. */
async function deliver(row, ctx, recording) {
  const startedAt = Date.now();
  const { subject, html, text, attachments } = buildNotificationEmail({
    call: ctx.call,
    event: row.event,
    companyName: ctx.companyName,
    whenLabel: ctx.whenLabel,
    recording,
    portalUrl: buildPortalUrl(ctx.callId),
  });

  logger.info(`${PREFIX} drain   4/6 — email built`, {
    retellCallId: row.retell_call_id, sendId: row.id, email: maskEmail(row.email),
    event: row.event, subject,
    attachments: attachments.map((a) => ({ filename: a.filename, type: a.contentType, bytes: a.content?.length ?? null })),
  });

  try {
    logger.info(`${PREFIX} drain   5/6 — handing to SendGrid`, {
      retellCallId: row.retell_call_id, sendId: row.id, email: maskEmail(row.email),
    });
    await sendMail({ to: row.email, subject, html, text, attachments });
  } catch (err) {
    if (row.attempts >= SEND_MAX_ATTEMPTS) {
      await sendsDb.markFailed(row.id, err.message);
      logger.error(`${PREFIX} drain   5/6 — GIVING UP after repeated send failures`, {
        retellCallId: row.retell_call_id, sendId: row.id, email: maskEmail(row.email),
        attempts: row.attempts, maxAttempts: SEND_MAX_ATTEMPTS, error: err.message, ms: since(startedAt),
      });
      return { sent: false, failed: true };
    }
    const retryAt = nextAttemptAt(row.attempts, new Date());
    await sendsDb.markRetry(row.id, { nextAttemptAt: retryAt, error: err.message });
    logger.warn(`${PREFIX} drain   5/6 — send failed, will retry`, {
      retellCallId: row.retell_call_id, sendId: row.id, email: maskEmail(row.email),
      attempts: row.attempts, maxAttempts: SEND_MAX_ATTEMPTS,
      nextAttemptAt: retryAt.toISOString(), error: err.message, ms: since(startedAt),
    });
    return { sent: false, failed: false };
  }

  const recordingAttached = recording ? recording.status === "ok" : null;
  await sendsDb.markSentSafe(row.id, {
    recordingAttached,
    attachmentBytes: recording?.status === "ok" ? recording.bytes : null,
  });
  logger.info(`${PREFIX} drain   6/6 — SENT`, {
    retellCallId: row.retell_call_id, sendId: row.id, email: maskEmail(row.email),
    event: row.event, recordingAttached, ms: since(startedAt),
  });
  return { sent: true, failed: false };
}

/**
 * One pass over everything due.
 *
 * Rows are grouped by conversation so the recording is downloaded ONCE and
 * shared by every recipient of that call — three recipients must not mean three
 * multi-megabyte downloads.
 */
async function runSweep(now = new Date()) {
  const sweepStartedAt = Date.now();
  const due = await sendsDb.claimDueBatch(BATCH_SIZE, now);
  const results = { claimed: due.length, sent: 0, held: 0, failed: 0, errors: 0 };

  if (!due.length) {
    // debug, not info: this fires every minute of every day and would drown
    // the real pipeline lines at info level.
    logger.debug(`${PREFIX} drain   0/6 — nothing due`, { batchSize: BATCH_SIZE });
    return results;
  }

  const byCall = new Map();
  for (const row of due) {
    if (!byCall.has(row.retell_call_id)) byCall.set(row.retell_call_id, []);
    byCall.get(row.retell_call_id).push(row);
  }

  logger.info(`${PREFIX} drain   0/6 — sweep start`, {
    claimed: due.length, conversations: byCall.size, batchSize: BATCH_SIZE,
  });

  for (const [retellCallId, rows] of byCall) {
    const convStartedAt = Date.now();
    try {
      logger.info(`${PREFIX} drain   1/6 — conversation`, {
        retellCallId, companyId: rows[0].company_id, recipients: rows.length,
        event: rows[0].event, channel: rows[0].channel,
        attempts: rows.map((r) => r.attempts),
      });

      const ctx = await loadContext(rows[0].company_id, retellCallId);
      if (!ctx) {
        // The call row is gone (a resync, a deleted company). Nothing to
        // describe, so stop retrying rather than looping forever.
        for (const row of rows) await sendsDb.markFailed(row.id, "Call row no longer exists");
        results.failed += rows.length;
        logger.error(`${PREFIX} drain   2/6 — ABANDONED: the call row no longer exists`, {
          retellCallId, rows: rows.length,
        });
        continue;
      }

      const isChat = (ctx.call.channel || "voice") === "sms";
      // The least-tried row decides whether the group still has patience left,
      // so a recipient added late cannot shorten the audio's retry budget.
      const minAttempts = Math.min(...rows.map((r) => r.attempts));
      const { recording, holdFor } = await resolveRecording({
        call: ctx.call, retellCallId, minAttempts, isChat,
      });

      if (holdFor) {
        let retryAt = null;
        for (const row of rows) {
          retryAt = nextAttemptAt(row.attempts, now);
          await sendsDb.markRetry(row.id, { nextAttemptAt: retryAt, error: holdFor });
        }
        results.held += rows.length;
        logger.info(`${PREFIX} drain   3/6 — HOLDING: recording not ready, nothing sent yet`, {
          retellCallId, rows: rows.length,
          attempt: minAttempts, maxAttempts: RECORDING_MAX_ATTEMPTS,
          nextAttemptAt: retryAt ? retryAt.toISOString() : null,
          reason: holdFor, ms: since(convStartedAt),
        });
        continue;
      }

      for (const row of rows) {
        try {
          const r = await deliver(row, ctx, recording);
          if (r.sent) results.sent += 1;
          else if (r.failed) results.failed += 1;
          else results.errors += 1;
        } catch (err) {
          // Per ROW: one unroutable address must not silence the others.
          results.errors += 1;
          logger.error(`${PREFIX} drain   6/6 — row failed unexpectedly`, {
            retellCallId, sendId: row.id, email: maskEmail(row.email),
            error: err.message, stack: err.stack,
          });
        }
      }

      logger.info(`${PREFIX} drain   6/6 — conversation done`, {
        retellCallId, recipients: rows.length, ms: since(convStartedAt),
      });
    } catch (err) {
      // Per CONVERSATION: one broken call must not stop the batch.
      results.errors += rows.length;
      logger.error(`${PREFIX} drain   — conversation failed unexpectedly`, {
        retellCallId, rows: rows.length, error: err.message, stack: err.stack,
        ms: since(convStartedAt),
      });
    }
  }

  logger.info(`${PREFIX} drain   — sweep complete`, {
    ...results, conversations: byCall.size, ms: since(sweepStartedAt),
  });
  return results;
}

/**
 * Send one notification right now, ignoring the queue, the event filter and the
 * dedup index — the "Send test now" button. Deliberately repeatable, and it
 * reports what happened (including whether the audio attached) rather than
 * queueing silently.
 */
async function sendTestNow({ companyId, callId, toEmail, recipientName = null, event = null }) {
  const startedAt = Date.now();
  logger.info(`${PREFIX} test    1/4 — manual test send requested`, {
    companyId, callId, email: maskEmail(toEmail), event,
  });

  const call = await callsDb.getById(callId, companyId);
  if (!call) {
    logger.warn(`${PREFIX} test    1/4 — STOP: call not found`, { companyId, callId });
    const err = new Error("Call not found");
    err.code = "NOT_FOUND";
    throw err;
  }

  const [companyRows, tz] = await Promise.all([
    db.query(`SELECT name FROM companies WHERE id = $1`, [companyId]),
    getCompanyTimezone(companyId),
  ]);

  const isChat = (call.channel || "voice") === "sms";
  logger.info(`${PREFIX} test    2/4 — call loaded`, {
    callId, retellCallId: call.retell_call_id, channel: call.channel || "voice",
    customer: call.customer?.name || call.location_name || null,
    hasRecordingUrl: !!call.has_recording,
  });

  let recording = null;
  if (!isChat) {
    let url = await callsDb.getRecordingUrlByRetellId(call.retell_call_id);
    if (!url) url = await lookupRecordingUrl(call.retell_call_id);
    recording = await fetchRecording(url);
    // Unlike the drain, a test never waits — it reports what it got, since
    // "did the audio attach?" is the entire point of pressing the button.
    logger.info(`${PREFIX} test    3/4 — recording resolved`, {
      callId, status: recording.status, bytes: recording.bytes, reason: recording.reason,
    });
  } else {
    logger.info(`${PREFIX} test    3/4 — chat conversation, no recording expected`, { callId });
  }

  const { subject, html, text, attachments } = buildNotificationEmail({
    call,
    event: event || "confirmed",
    companyName: companyRows.rows[0]?.name || "Your company",
    whenLabel: call.created_at ? formatSpokenDateTime(call.created_at, tz) : null,
    recording,
    portalUrl: buildPortalUrl(callId),
    recipientName,
  });

  await sendMail({ to: toEmail, subject, html, text, attachments });

  logger.info(`${PREFIX} test    4/4 — SENT`, {
    companyId, callId, email: maskEmail(toEmail), subject,
    recordingAttached: recording ? recording.status === "ok" : null,
    attachments: attachments.map((a) => ({ filename: a.filename, type: a.contentType, bytes: a.content?.length ?? null })),
    ms: since(startedAt),
  });

  return {
    sent_to: toEmail,
    call_id: callId,
    subject,
    recording_attached: recording ? recording.status === "ok" : null,
    recording_note: recording && recording.status !== "ok" ? recording.reason : null,
    attachment_bytes: recording?.status === "ok" ? recording.bytes : null,
  };
}

module.exports = { runSweep, sendTestNow, nextAttemptAt, RECORDING_MAX_ATTEMPTS, BACKOFF_MINUTES };
