/**
 * Own the recordings: pull each call's audio from Retell into our private
 * Supabase bucket, and delete it again once the retention window expires.
 *
 * WHY THIS IS ITS OWN SWEEP, not part of the notification drain: the drain only
 * runs when somebody is subscribed to that call's outcome. Hanging archival off
 * it would mean a company with notifications switched off retains no audio at
 * all — the gap would sit exactly where nobody is watching. Retention is a
 * property of the record, not of anyone's email preferences.
 *
 * Two sweeps, two crons:
 *   runArchiveSweep — voice calls with no copy yet  → download → upload → stamp
 *   runPurgeSweep   — copies past RECORDING_RETENTION_DAYS → delete → stamp
 */

const db = require("./../db");
const storage = require("./supabase-storage");
const logger = require("../utils/logger");
const { fetchRecording, lookupRecordingUrl } = require("./call-notification/recording");
const { PREFIX, maskUrl, since } = require("./call-notification/log");
const { fetchStreaming } = require("../utils/streaming-fetch");

const BUCKET = process.env.RECORDING_BUCKET || "call-recordings";

const ARCHIVE_BATCH_SIZE = Number(process.env.RECORDING_ARCHIVE_BATCH_SIZE) || 20;
const ARCHIVE_MAX_ATTEMPTS = Number(process.env.RECORDING_ARCHIVE_MAX_ATTEMPTS) || 6;

/**
 * How long a recording lives, measured from the CALL, not from when we happened
 * to archive it.
 *
 * That distinction is not pedantic. Measuring from `recording_archived_at`
 * means backfilling an old call resurrects audio that policy says should
 * already be gone — archive a call from five months ago today and we would hold
 * it for another full retention window. 125 of this database's voice calls are
 * already older than the window, so that is the common case, not the edge one.
 * Age of the conversation is what a retention policy is actually about.
 *
 * Deliberately an env var: this deletes customer conversation audio
 * irreversibly, so changing the window should be a config edit, not a deploy.
 */
const RETENTION_DAYS = Number(process.env.RECORDING_RETENTION_DAYS) || 30;
const PURGE_BATCH_SIZE = Number(process.env.RECORDING_PURGE_BATCH_SIZE) || 50;

/** `<company_id>/<retell_call_id>/recording.<ext>` — see migration 108. */
function buildObjectPath({ companyId, retellCallId, ext }) {
  const safeId = String(retellCallId).replace(/[^A-Za-z0-9_-]/g, "");
  return `${companyId}/${safeId}/recording.${ext || "wav"}`;
}

// ── Archive ──────────────────────────────────────────────────────────────────

/**
 * Voice calls we hold no copy of yet.
 *
 * `recording_purged_at IS NULL` is the important clause: a deliberately-deleted
 * recording must never be re-downloaded, or the retention policy would undo
 * itself on the next pass.
 */
async function listPending(limit) {
  const { rows } = await db.query(
    `SELECT id, company_id, retell_call_id, recording_url, recording_archive_attempts, created_at
       FROM calls
      WHERE channel = 'voice'
        AND status = 'analyzed'
        AND recording_storage_path IS NULL
        AND recording_purged_at IS NULL
        AND recording_archive_attempts < $2
        -- Bounded by the RETENTION window, not a separate lookback knob. A call
        -- already past retention must never be archived: we would download it
        -- only for the purge sweep to delete it again, having briefly stored
        -- audio the policy says should not exist. Tying both to one constant
        -- makes it impossible for the two windows to disagree.
        AND created_at > now() - ($3 || ' days')::interval
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit, ARCHIVE_MAX_ATTEMPTS, String(RETENTION_DAYS)]
  );
  return rows;
}

async function markArchived(callId, { path, bytes, contentType }) {
  await db.query(
    `UPDATE calls
        SET recording_storage_path = $2, recording_bytes = $3, recording_content_type = $4,
            recording_archived_at = now(), recording_archive_error = NULL, updated_at = now()
      WHERE id = $1`,
    [callId, path, bytes, contentType]
  );
}

async function markArchiveAttempt(callId, error) {
  await db.query(
    `UPDATE calls
        SET recording_archive_attempts = recording_archive_attempts + 1,
            recording_archive_error = $2, updated_at = now()
      WHERE id = $1`,
    [callId, error ? String(error).slice(0, 500) : null]
  );
}

/** Archive exactly one call. Never throws — the caller tallies. */
async function archiveOne(row) {
  const startedAt = Date.now();
  const { id: callId, company_id: companyId, retell_call_id: retellCallId } = row;

  let url = row.recording_url;
  if (!url) {
    // Analysed before Retell attached the recording, or a call from before
    // migration 107 started capturing the URL at all.
    url = await lookupRecordingUrl(retellCallId);
    if (url) {
      await db.query(`UPDATE calls SET recording_url = $2, updated_at = now() WHERE id = $1`, [callId, url])
        .catch((err) => logger.warn(`${PREFIX} archive    → could not persist looked-up URL`, { callId, error: err.message }));
    }
  }

  if (!url) {
    await markArchiveAttempt(callId, "No recording URL available from Retell");
    logger.info(`${PREFIX} archive    → no URL available yet`, {
      callId, retellCallId, attempts: row.recording_archive_attempts + 1, maxAttempts: ARCHIVE_MAX_ATTEMPTS,
    });
    return { archived: false, reason: "no_url" };
  }

  const recording = await fetchRecording(url);
  if (recording.status !== "ok") {
    await markArchiveAttempt(callId, recording.reason);
    logger.warn(`${PREFIX} archive    → could not download`, {
      callId, retellCallId, url: maskUrl(url), status: recording.status,
      reason: recording.reason, attempts: row.recording_archive_attempts + 1,
    });
    return { archived: false, reason: recording.status };
  }

  const objectPath = buildObjectPath({ companyId, retellCallId, ext: recording.ext });
  const up = await storage.upload(BUCKET, objectPath, recording.buffer, recording.contentType);
  if (!up.ok) {
    await markArchiveAttempt(callId, up.error);
    logger.error(`${PREFIX} archive    → upload to our bucket failed`, {
      callId, retellCallId, objectPath, error: up.error, attempts: row.recording_archive_attempts + 1,
    });
    return { archived: false, reason: "upload_failed" };
  }

  await markArchived(callId, { path: objectPath, bytes: recording.bytes, contentType: recording.contentType });
  logger.info(`${PREFIX} archive    → STORED in our bucket`, {
    callId, retellCallId, objectPath, kb: Math.round(recording.bytes / 1024),
    contentType: recording.contentType, ms: since(startedAt),
  });
  return { archived: true };
}

/**
 * One archive pass. Per-row isolation, same as the notification drain: one
 * unreachable recording must not stop the rest of the batch.
 */
async function runArchiveSweep() {
  const startedAt = Date.now();
  const results = { considered: 0, archived: 0, skipped: 0, errors: 0 };

  if (!storage.isConfigured()) {
    logger.error(`${PREFIX} archive    — SKIPPED: Supabase storage is not configured`);
    results.errors = 1;
    return results;
  }

  const pending = await listPending(ARCHIVE_BATCH_SIZE);
  results.considered = pending.length;
  if (!pending.length) {
    logger.debug(`${PREFIX} archive    — nothing to archive`);
    return results;
  }

  logger.info(`${PREFIX} archive    — sweep start`, {
    pending: pending.length, bucket: BUCKET, maxAttempts: ARCHIVE_MAX_ATTEMPTS,
  });

  for (const row of pending) {
    try {
      const r = await archiveOne(row);
      if (r.archived) results.archived += 1;
      else results.skipped += 1;
    } catch (err) {
      results.errors += 1;
      logger.error(`${PREFIX} archive    → row failed unexpectedly`, {
        callId: row.id, retellCallId: row.retell_call_id, error: err.message, stack: err.stack,
      });
    }
  }

  logger.info(`${PREFIX} archive    — sweep complete`, { ...results, ms: since(startedAt) });
  return results;
}

// ── Purge (retention) ────────────────────────────────────────────────────────

/**
 * Delete archived audio older than the retention window.
 *
 * `recording_purged_at` is stamped and `recording_storage_path` cleared in the
 * same statement, so the archive sweep cannot pick the row back up. The
 * transcript, summary and Retell URL are all left intact — only our copy of the
 * audio goes.
 */
async function runPurgeSweep() {
  const startedAt = Date.now();
  const results = { considered: 0, purged: 0, errors: 0, retentionDays: RETENTION_DAYS };

  if (!storage.isConfigured()) {
    logger.error(`${PREFIX} purge      — SKIPPED: Supabase storage is not configured`);
    results.errors = 1;
    return results;
  }

  const { rows } = await db.query(
    `SELECT id, company_id, retell_call_id, recording_storage_path, recording_bytes,
            recording_archived_at, created_at
       FROM calls
      WHERE recording_storage_path IS NOT NULL
        AND created_at < now() - ($2 || ' days')::interval
      ORDER BY created_at
      LIMIT $1`,
    [PURGE_BATCH_SIZE, String(RETENTION_DAYS)]
  );
  results.considered = rows.length;
  if (!rows.length) {
    logger.debug(`${PREFIX} purge      — nothing past retention`, { retentionDays: RETENTION_DAYS });
    return results;
  }

  logger.info(`${PREFIX} purge      — sweep start`, { considered: rows.length, retentionDays: RETENTION_DAYS });

  for (const row of rows) {
    try {
      const del = await storage.remove(BUCKET, row.recording_storage_path);
      if (!del.ok) {
        results.errors += 1;
        // NOT stamped as purged: the row is retried next pass rather than
        // recorded as deleted while the object is still sitting in the bucket.
        logger.error(`${PREFIX} purge      → delete failed, will retry`, {
          callId: row.id, objectPath: row.recording_storage_path, error: del.error,
        });
        continue;
      }

      await db.query(
        `UPDATE calls
            SET recording_purged_at = now(), recording_storage_path = NULL, updated_at = now()
          WHERE id = $1`,
        [row.id]
      );
      results.purged += 1;
      // Logged per object, at info, on purpose: this is an irreversible deletion
      // of customer audio and should be auditable from the logs alone.
      logger.info(`${PREFIX} purge      → DELETED (past ${RETENTION_DAYS}-day retention)`, {
        callId: row.id, companyId: row.company_id, retellCallId: row.retell_call_id,
        objectPath: row.recording_storage_path,
        kb: row.recording_bytes ? Math.round(Number(row.recording_bytes) / 1024) : null,
        callDate: row.created_at, archivedAt: row.recording_archived_at,
      });
    } catch (err) {
      results.errors += 1;
      logger.error(`${PREFIX} purge      → row failed unexpectedly`, {
        callId: row.id, error: err.message, stack: err.stack,
      });
    }
  }

  logger.info(`${PREFIX} purge      — sweep complete`, { ...results, ms: since(startedAt) });
  return results;
}

/**
 * The audio for one call, preferring OUR copy and falling back to Retell.
 *
 * Both the portal player and the notification email read through this, so
 * neither depends on Retell once a call is archived — and both keep working in
 * the window before the archive sweep has caught up.
 *
 * `abort` cancels an in-flight body. The caller MUST wire it to the client
 * disconnecting, or a closed browser tab leaves the upstream transfer running.
 *
 * @returns {Promise<{source: "archive"|"retell"|"none", response: Response|null, purged: boolean, abort: function}>}
 */
async function openRecording({ storagePath, retellUrl, purgedAt = null, range = null }) {
  const noop = () => {};

  if (storagePath) {
    const res = await storage.download(BUCKET, storagePath, { range });
    if (res && (res.ok || res.status === 206)) {
      return { source: "archive", response: res, purged: false, abort: noop };
    }
    logger.warn(`${PREFIX} serve      → archived object unreadable, falling back to Retell`, {
      objectPath: storagePath, status: res?.status ?? null,
    });
  }

  if (retellUrl) {
    try {
      // Response-phase timeout only — a total timeout aborts a healthy but
      // large download mid-stream. See utils/streaming-fetch.js.
      const { response: res, abort } = await fetchStreaming(retellUrl, {
        headers: range ? { Range: range } : undefined,
        responseTimeoutMs: 20000,
      });
      if (res.ok || res.status === 206) {
        return { source: "retell", response: res, purged: !!purgedAt, abort };
      }
      logger.warn(`${PREFIX} serve      → Retell returned HTTP ${res.status}`, { url: maskUrl(retellUrl) });
    } catch (err) {
      logger.warn(`${PREFIX} serve      → Retell fetch threw`, { url: maskUrl(retellUrl), error: err.message });
    }
  }

  return { source: "none", response: null, purged: !!purgedAt, abort: noop };
}

module.exports = {
  runArchiveSweep, runPurgeSweep, archiveOne, openRecording, buildObjectPath,
  BUCKET, RETENTION_DAYS, ARCHIVE_MAX_ATTEMPTS,
};
