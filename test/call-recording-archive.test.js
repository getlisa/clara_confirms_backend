/**
 * Owning the recordings: the archive sweep, the retention purge, and the
 * serving preference.
 *
 * The properties that matter:
 *   - archival is INDEPENDENT of notification settings (its own sweep);
 *   - a purged recording is never re-downloaded — otherwise retention undoes
 *     itself on the next pass;
 *   - a failed delete is NOT recorded as purged, or we would claim to have
 *     deleted audio that is still sitting in the bucket;
 *   - serving prefers our copy and only falls back to Retell.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);

// ── db ───────────────────────────────────────────────────────────────────────
const queries = [];
let pendingRows = [];
let purgeRows = [];
stub("db", {
  query: async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, " ");
    queries.push({ sql: flat, params });
    if (/FROM calls WHERE channel = 'voice'/.test(flat)) return { rows: pendingRows };
    if (/recording_storage_path IS NOT NULL AND created_at </.test(flat)) return { rows: purgeRows };
    return { rows: [] };
  },
});

// ── storage ──────────────────────────────────────────────────────────────────
const uploads = [];
const removals = [];
let uploadImpl = async () => ({ ok: true, status: 200, error: null });
let removeImpl = async () => ({ ok: true, status: 200, error: null });
let downloadImpl = async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(8) });
let configured = true;
stub("services/supabase-storage", {
  isConfigured: () => configured,
  upload: async (bucket, path, body, type) => { uploads.push({ bucket, path, bytes: body?.length, type }); return uploadImpl(); },
  remove: async (bucket, path) => { removals.push({ bucket, path }); return removeImpl(); },
  download: async (...a) => downloadImpl(...a),
  exists: async () => true,
});

// ── the Retell download ──────────────────────────────────────────────────────
let fetchResult = { status: "ok", buffer: Buffer.alloc(2048), contentType: "audio/wav", ext: "wav", bytes: 2048, reason: null };
let lookupResult = null;
stub("services/call-notification/recording", {
  fetchRecording: async () => fetchResult,
  lookupRecordingUrl: async () => lookupResult,
});

function reset() {
  queries.length = 0; uploads.length = 0; removals.length = 0;
  pendingRows = []; purgeRows = [];
  uploadImpl = async () => ({ ok: true, status: 200, error: null });
  removeImpl = async () => ({ ok: true, status: 200, error: null });
  downloadImpl = async () => ({ ok: true, status: 200, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(8) });
  fetchResult = { status: "ok", buffer: Buffer.alloc(2048), contentType: "audio/wav", ext: "wav", bytes: 2048, reason: null };
  lookupResult = null;
  configured = true;
  logger.reset();
}

const pending = (o = {}) => ({
  id: 607, company_id: 8, retell_call_id: "call_abc",
  recording_url: "https://cdn.retell.test/x/recording.wav",
  recording_archive_attempts: 0, created_at: new Date().toISOString(), ...o,
});

const archive = require("../src/services/call-recording-archive");
const { runArchiveSweep, runPurgeSweep, buildObjectPath, openRecording } = archive;

// ── object keys ──────────────────────────────────────────────────────────────

test("the object key is company-prefixed so one company's audio is one prefix", () => {
  assert.equal(
    buildObjectPath({ companyId: 8, retellCallId: "call_abc123", ext: "wav" }),
    "8/call_abc123/recording.wav"
  );
});

test("a hostile call id cannot escape the company prefix", () => {
  const p = buildObjectPath({ companyId: 8, retellCallId: "../../etc/passwd", ext: "wav" });
  assert.ok(!p.includes(".."), p);
  assert.ok(p.startsWith("8/"), p);
});

// ── archive sweep ────────────────────────────────────────────────────────────

test("downloads from Retell, uploads to our bucket, stamps the row", async () => {
  reset();
  pendingRows = [pending()];

  const result = await runArchiveSweep();

  assert.deepEqual(result, { considered: 1, archived: 1, skipped: 0, errors: 0 });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].path, "8/call_abc/recording.wav");
  assert.equal(uploads[0].type, "audio/wav");
  assert.ok(queries.some((q) => /SET recording_storage_path = \$2/.test(q.sql)), "the row is stamped");
});

test("the pending query excludes purged rows — retention must not undo itself", async () => {
  reset();
  pendingRows = [];
  await runArchiveSweep();

  const q = queries.find((x) => /FROM calls WHERE channel = 'voice'/.test(x.sql));
  assert.ok(q, "the sweep queried for pending rows");
  assert.ok(/recording_purged_at IS NULL/.test(q.sql),
    "a deliberately-deleted recording is never a candidate for re-download");
  assert.ok(/recording_storage_path IS NULL/.test(q.sql), "and neither is one we already hold");
  assert.ok(/recording_archive_attempts < /.test(q.sql), "attempts are bounded");
});

test("the sweep does not consult notification settings at all", async () => {
  reset();
  pendingRows = [pending()];
  await runArchiveSweep();

  // Archival is a property of the record, not of anyone's email preferences: a
  // company with notifications off must still retain its audio.
  const all = queries.map((q) => q.sql).join(" ");
  assert.ok(!/call_notification_enabled/.test(all));
  assert.ok(!/call_notification_recipients/.test(all));
});

test("a recording Retell has not attached yet counts an attempt and retries later", async () => {
  reset();
  pendingRows = [pending({ recording_url: null })];
  lookupResult = null; // Retell has nothing either

  const result = await runArchiveSweep();

  assert.equal(result.archived, 0);
  assert.equal(result.skipped, 1);
  assert.equal(uploads.length, 0);
  assert.ok(queries.some((q) => /recording_archive_attempts = recording_archive_attempts \+ 1/.test(q.sql)),
    "the attempt is counted, so it cannot retry forever");
});

test("a URL missing from the webhook is recovered from Retell and persisted", async () => {
  reset();
  pendingRows = [pending({ recording_url: null })];
  lookupResult = "https://cdn.retell.test/late/recording.wav";

  const result = await runArchiveSweep();

  assert.equal(result.archived, 1);
  assert.ok(queries.some((q) => /SET recording_url = \$2/.test(q.sql)),
    "the recovered URL is kept, so the next reader need not ask Retell again");
});

test("an upload failure is recorded and retried, never stamped as archived", async () => {
  reset();
  pendingRows = [pending()];
  uploadImpl = async () => ({ ok: false, status: 500, error: "Storage upload failed: HTTP 500" });

  const result = await runArchiveSweep();

  assert.equal(result.archived, 0);
  assert.ok(!queries.some((q) => /SET recording_storage_path = \$2/.test(q.sql)),
    "a failed upload must not claim we hold a copy");
  assert.ok(queries.some((q) => /recording_archive_attempts = recording_archive_attempts \+ 1/.test(q.sql)));
});

test("one bad row does not stop the batch", async () => {
  reset();
  pendingRows = [pending({ id: 1 }), pending({ id: 2, retell_call_id: "call_two" })];
  let first = true;
  uploadImpl = async () => {
    if (first) { first = false; throw new Error("socket hang up"); }
    return { ok: true, status: 200, error: null };
  };

  const result = await runArchiveSweep();
  assert.equal(result.considered, 2);
  assert.equal(result.archived + result.errors, 2, "both rows were accounted for");
  assert.ok(result.archived >= 1, "the healthy row still archived");
});

test("unconfigured storage is reported loudly, not silently skipped", async () => {
  reset();
  configured = false;
  const result = await runArchiveSweep();
  assert.equal(result.errors, 1);
  assert.ok(logger.records.error.some(([m]) => /storage is not configured/i.test(String(m))));
});

// ── retention purge ──────────────────────────────────────────────────────────

test("purge deletes the object and stamps purged_at while clearing the path", async () => {
  reset();
  purgeRows = [{ id: 607, company_id: 8, retell_call_id: "call_abc",
                 recording_storage_path: "8/call_abc/recording.wav",
                 recording_bytes: 2048, recording_archived_at: "2026-01-01T00:00:00Z" }];

  const result = await runPurgeSweep();

  assert.equal(result.purged, 1);
  assert.equal(removals.length, 1);
  assert.equal(removals[0].path, "8/call_abc/recording.wav");
  const upd = queries.find((q) => /SET recording_purged_at = now\(\)/.test(q.sql));
  assert.ok(upd, "purged_at is stamped");
  assert.ok(/recording_storage_path = NULL/.test(upd.sql), "and the stale path is cleared");
});

test("a failed delete is NOT recorded as purged", async () => {
  reset();
  purgeRows = [{ id: 607, company_id: 8, retell_call_id: "call_abc",
                 recording_storage_path: "8/call_abc/recording.wav",
                 recording_bytes: 2048, recording_archived_at: "2026-01-01T00:00:00Z" }];
  removeImpl = async () => ({ ok: false, status: 500, error: "Storage delete failed: HTTP 500" });

  const result = await runPurgeSweep();

  assert.equal(result.purged, 0);
  assert.equal(result.errors, 1);
  // Claiming a deletion that did not happen would leave customer audio in the
  // bucket with nothing left pointing at it to ever clean it up.
  assert.ok(!queries.some((q) => /SET recording_purged_at = now\(\)/.test(q.sql)));
});

test("every deletion is logged individually, so the purge is auditable", async () => {
  reset();
  purgeRows = [
    { id: 1, company_id: 8, retell_call_id: "a", recording_storage_path: "8/a/recording.wav", recording_bytes: 10, recording_archived_at: "2026-01-01T00:00:00Z" },
    { id: 2, company_id: 8, retell_call_id: "b", recording_storage_path: "8/b/recording.wav", recording_bytes: 20, recording_archived_at: "2026-01-01T00:00:00Z" },
  ];
  await runPurgeSweep();

  const deletions = logger.records.info.filter(([m]) => /DELETED/.test(String(m)));
  assert.equal(deletions.length, 2, "one log line per irreversible deletion");
  assert.ok(deletions.every(([, meta]) => meta.objectPath && meta.callId));
});

test("purge measures the window from the CALL date, not from when we archived it", async () => {
  reset();
  purgeRows = [];
  await runPurgeSweep();

  const q = queries.find((x) => /recording_storage_path IS NOT NULL/.test(x.sql) && /created_at </.test(x.sql));
  assert.ok(q, "the window is applied in SQL, not in JS");
  assert.equal(q.params[1], String(archive.RETENTION_DAYS));
  // Keying on recording_archived_at would mean backfilling an old call
  // resurrects audio that policy says is already expired.
  assert.ok(!/recording_archived_at </.test(q.sql),
    "retention must not be measured from our own archive timestamp");
});

test("the archive sweep refuses calls already past retention", async () => {
  reset();
  pendingRows = [];
  await runArchiveSweep();

  const q = queries.find((x) => /FROM calls WHERE channel = 'voice'/.test(x.sql));
  // Downloading a call already past retention would store audio the policy says
  // should not exist, only for the next purge pass to delete it again.
  assert.equal(q.params[2], String(archive.RETENTION_DAYS),
    "the archive window is bounded by the retention window, one constant for both");
});

test("retention defaults to 30 days", () => {
  assert.equal(archive.RETENTION_DAYS, 30);
});

// ── serving ──────────────────────────────────────────────────────────────────

test("serving prefers our archived copy and never touches Retell for it", async () => {
  reset();
  let retellHit = false;
  global.fetch = async () => { retellHit = true; return { ok: true, status: 200 }; };

  const { source } = await openRecording({
    storagePath: "8/call_abc/recording.wav",
    retellUrl: "https://cdn.retell.test/x/recording.wav",
  });

  assert.equal(source, "archive");
  assert.equal(retellHit, false, "an archived call does not depend on Retell at all");
});

test("serving falls back to Retell while the archive has not caught up", async () => {
  reset();
  global.fetch = async () => ({ ok: true, status: 200 });

  const { source } = await openRecording({
    storagePath: null,
    retellUrl: "https://cdn.retell.test/x/recording.wav",
  });
  assert.equal(source, "retell");
});

test("an unreadable archived object falls back rather than failing outright", async () => {
  reset();
  downloadImpl = async () => ({ ok: false, status: 404 });
  global.fetch = async () => ({ ok: true, status: 200 });

  const { source } = await openRecording({
    storagePath: "8/call_abc/recording.wav",
    retellUrl: "https://cdn.retell.test/x/recording.wav",
  });
  assert.equal(source, "retell");
  assert.ok(logger.records.warn.some(([m]) => /unreadable, falling back/.test(String(m))));
});

test("with neither source, serving reports 'none' and whether it was purged", async () => {
  reset();
  const r = await openRecording({ storagePath: null, retellUrl: null, purgedAt: "2026-01-01T00:00:00Z" });
  assert.equal(r.source, "none");
  assert.equal(r.response, null);
  assert.equal(r.purged, true, "so the route can answer 410 Gone rather than a bare 404");
});
