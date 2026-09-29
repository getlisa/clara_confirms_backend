/**
 * Stage 2: the sweep that fetches the recording and sends.
 *
 * Four properties carry this feature:
 *   - the recording is downloaded ONCE per conversation, not once per recipient;
 *   - a recording that is not ready yet is WAITED for, not lost;
 *   - once patience runs out the email still goes, minus the audio;
 *   - no Retell URL ever reaches the message — the audio travels as bytes.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);

// ── the queue ────────────────────────────────────────────────────────────────
let dueRows = [];
const marks = { sent: [], retry: [], failed: [] };
stub("db/call-notification-sends", {
  claimDueBatch: async () => dueRows.map((r) => ({ ...r, attempts: r.attempts + 1 })),
  markSent:     async (id, opts) => { marks.sent.push({ id, ...opts }); },
  markSentSafe: async (id, opts) => { marks.sent.push({ id, ...opts }); },
  markRetry:    async (id, opts) => { marks.retry.push({ id, ...opts }); },
  markFailed:   async (id, error) => { marks.failed.push({ id, error }); },
});

// ── the call ─────────────────────────────────────────────────────────────────
let call = null;
let recordingUrl = null;
const recordingUrlReads = [];
stub("db/calls", {
  getById: async () => call,
  getRecordingUrlByRetellId: async (id) => { recordingUrlReads.push(id); return recordingUrl; },
  getRecordingUrl: async () => recordingUrl,
  setRecordingUrl: async (id, url) => { recordingUrl = url; },
});

stub("db", {
  query: async (sql) => {
    if (/FROM calls WHERE retell_call_id/.test(sql)) return { rows: call ? [{ id: call.id }] : [] };
    if (/FROM companies/.test(sql)) return { rows: [{ name: "Ultimate Fire Protection" }] };
    return { rows: [] };
  },
});

// ── email ────────────────────────────────────────────────────────────────────
const sent = [];
let sendMailImpl = async () => true;
stub("utils/email", {
  COMPANY_NAME: "Clara Confirms",
  buildEmailTemplate: ({ title, bodyHtml }) => `<html><p>${title}</p>${bodyHtml}</html>`,
  sendMail: async (args) => { sent.push(args); return sendMailImpl(args); },
});

stub("utils/timezone", {
  getCompanyTimezone: async () => "America/New_York",
  formatSpokenDateTime: () => "Tuesday 29 September at 11:00 AM",
});

// ── the recording fetch ──────────────────────────────────────────────────────
// Stubbed at the module boundary so the drain's grouping (one fetch per
// conversation) is directly observable.
let fetchResult = { status: "ok", buffer: Buffer.alloc(4096), contentType: "audio/wav", ext: "wav", bytes: 4096, reason: null };
const fetchCalls = [];
stub("services/call-notification/recording", {
  fetchRecording: async (url) => { fetchCalls.push(url); return fetchResult; },
  lookupRecordingUrl: async () => null,
});

const RETELL_URL = "https://retell-recordings.s3.amazonaws.com/call_abc.wav?sig=deadbeef";

function baseCall(overrides = {}) {
  return {
    id: 42, retell_call_id: "call_abc", channel: "voice", is_test: false,
    to_number: "+19402324304", duration_ms: 185000, user_sentiment: "Positive",
    call_summary: "Erica confirmed the annual sprinkler inspection on Wed 12 Aug.",
    transcript: "Agent: Hello, calling to confirm.\nUser: Yes, that works.",
    location_name: "Columbus Park", job_name: "Annual Sprinkler",
    customer: { name: "Ultimate Fire" }, created_at: "2026-09-29T15:00:00.000Z",
    has_recording: true,
    ...overrides,
  };
}

function row(overrides = {}) {
  return {
    id: 1, company_id: 8, call_id: 42, retell_call_id: "call_abc",
    recipient_id: 1, email: "erica@ufp.test", event: "confirmed",
    channel: "voice", status: "pending", attempts: 0,
    ...overrides,
  };
}

function reset() {
  dueRows = [];
  marks.sent.length = 0; marks.retry.length = 0; marks.failed.length = 0;
  sent.length = 0;
  sendMailImpl = async () => true;
  call = baseCall();
  recordingUrl = RETELL_URL;
  recordingUrlReads.length = 0;
  fetchCalls.length = 0;
  fetchResult = { status: "ok", buffer: Buffer.alloc(4096), contentType: "audio/wav", ext: "wav", bytes: 4096, reason: null };
  logger.reset();
}

const { runSweep, nextAttemptAt, BACKOFF_MINUTES, RECORDING_MAX_ATTEMPTS } =
  require("../src/services/call-notification/drain");

// ── the happy path ───────────────────────────────────────────────────────────

test("sends with the audio attached and stamps the row", async () => {
  reset();
  dueRows = [row()];

  const result = await runSweep();

  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "erica@ufp.test");
  assert.equal(sent[0].attachments.length, 2, "audio + transcript");
  assert.equal(sent[0].attachments[0].contentType, "audio/wav");
  assert.ok(sent[0].attachments[0].filename.endsWith(".wav"));
  assert.ok(Buffer.isBuffer(sent[0].attachments[0].content));
  assert.equal(marks.sent[0].recordingAttached, true);
  assert.equal(marks.sent[0].attachmentBytes, 4096);
});

test("the recording is fetched ONCE for three recipients of the same call", async () => {
  reset();
  dueRows = [
    row({ id: 1, email: "erica@ufp.test" }),
    row({ id: 2, email: "maxwell@ufp.test" }),
    row({ id: 3, email: "ops@ufp.test" }),
  ];

  const result = await runSweep();

  assert.equal(result.sent, 3);
  assert.equal(fetchCalls.length, 1, "three recipients must not mean three downloads");
  // All three still carry the audio.
  assert.ok(sent.every((m) => m.attachments.length === 2));
});

test("two different conversations each fetch their own recording", async () => {
  reset();
  dueRows = [row({ id: 1, retell_call_id: "call_abc" }), row({ id: 2, retell_call_id: "call_abc" })];
  await runSweep();
  assert.equal(fetchCalls.length, 1);
});

// ── the no-Retell-URL guarantee ──────────────────────────────────────────────

test("no Retell URL appears in the email, in any branch", async () => {
  for (const status of ["ok", "too_large", "bad_type"]) {
    reset();
    fetchResult = status === "ok"
      ? fetchResult
      : { status, buffer: null, contentType: null, ext: null, bytes: null, reason: "some reason" };
    dueRows = [row()];

    await runSweep();

    assert.equal(sent.length, 1, `${status} still sends`);
    const blob = JSON.stringify({ html: sent[0].html, text: sent[0].text, subject: sent[0].subject });
    assert.ok(!/retell/i.test(blob), `${status}: no "retell" in the message`);
    assert.ok(!blob.includes("s3.amazonaws.com"), `${status}: no S3 host in the message`);
    assert.ok(!blob.includes("deadbeef"), `${status}: no signature in the message`);
  }
});

// ── waiting for a recording that is not ready ────────────────────────────────

test("an unavailable recording holds the row instead of sending a silent email", async () => {
  reset();
  fetchResult = { status: "unavailable", buffer: null, contentType: null, ext: null, bytes: null,
                  reason: "Recording fetch returned HTTP 404" };
  dueRows = [row({ attempts: 0 })];

  const result = await runSweep();

  assert.equal(result.sent, 0);
  assert.equal(result.held, 1);
  assert.equal(sent.length, 0, "nothing must go out yet");
  assert.equal(marks.retry.length, 1);
  assert.ok(marks.retry[0].nextAttemptAt instanceof Date);
  assert.match(marks.retry[0].error, /404/);
});

test("backoff lengthens with each attempt", async () => {
  const now = new Date("2026-09-29T12:00:00Z");
  const waits = [1, 2, 3, 4, 5].map((attempts) =>
    Math.round((nextAttemptAt(attempts, now) - now) / 60000)
  );
  assert.deepEqual(waits, BACKOFF_MINUTES, "1, 2, 4, 8, 16 minutes");
  // Past the table it holds at the longest interval rather than throwing.
  assert.equal(Math.round((nextAttemptAt(99, now) - now) / 60000), 16);
});

test("once the retry budget is spent the email goes out WITHOUT the audio", async () => {
  reset();
  fetchResult = { status: "unavailable", buffer: null, contentType: null, ext: null, bytes: null,
                  reason: "Recording fetch returned HTTP 404" };
  // claimDueBatch bumps attempts, so this row arrives at the limit.
  dueRows = [row({ attempts: RECORDING_MAX_ATTEMPTS })];

  const result = await runSweep();

  assert.equal(result.held, 0, "no more waiting");
  assert.equal(result.sent, 1, "the notification is NOT lost");
  assert.equal(sent[0].attachments.length, 1, "transcript only");
  assert.equal(sent[0].attachments[0].filename.slice(-4), ".txt");
  assert.equal(marks.sent[0].recordingAttached, false, "and it is recorded as such");
  assert.ok(/could not be attached/.test(sent[0].html), "the email says so plainly");
});

test("too_large does not wait at all — retrying cannot shrink the file", async () => {
  reset();
  fetchResult = { status: "too_large", buffer: null, contentType: null, ext: null, bytes: 99e6,
                  reason: "Recording is 94.4 MB, over the 12 MB email limit" };
  dueRows = [row({ attempts: 0 })];

  const result = await runSweep();

  assert.equal(result.held, 0);
  assert.equal(result.sent, 1);
  assert.equal(sent[0].attachments.length, 1);
  assert.ok(/94\.4 MB/.test(sent[0].html), "the size is explained to the reader");
});

test("the least-tried row sets the group's patience", async () => {
  reset();
  fetchResult = { status: "unavailable", buffer: null, contentType: null, ext: null, bytes: null, reason: "not ready" };
  // A recipient added late (attempts 0) alongside one that has nearly exhausted
  // its budget: the group must still wait, or the newcomer loses its audio.
  dueRows = [row({ id: 1, attempts: RECORDING_MAX_ATTEMPTS }), row({ id: 2, email: "new@ufp.test", attempts: 0 })];

  const result = await runSweep();

  assert.equal(result.held, 2, "both wait");
  assert.equal(sent.length, 0);
});

// ── chat ─────────────────────────────────────────────────────────────────────

test("a chat sends on the first pass and never fetches a recording", async () => {
  reset();
  call = baseCall({ channel: "sms", has_recording: false, transcript: [{ role: "agent", content: "Hi" }, { role: "user", content: "Yes" }] });
  dueRows = [row({ channel: "sms", event: "confirmed" })];

  const result = await runSweep();

  assert.equal(result.sent, 1);
  assert.equal(fetchCalls.length, 0, "chats have no recording to fetch");
  assert.equal(sent[0].attachments.length, 1, "transcript only");
  assert.ok(sent[0].subject.includes("Outbound chat"));
  assert.ok(!/could not be attached/.test(sent[0].html), "and no apology for a missing one");
  assert.equal(marks.sent[0].recordingAttached, null);
});

// ── isolation ────────────────────────────────────────────────────────────────

test("one unroutable address does not cost the other recipients their email", async () => {
  reset();
  dueRows = [row({ id: 1, email: "broken@ufp.test" }), row({ id: 2, email: "fine@ufp.test" })];
  sendMailImpl = async (args) => {
    if (args.to === "broken@ufp.test") throw new Error("550 mailbox unavailable");
    return true;
  };

  const result = await runSweep();

  assert.equal(result.sent, 1, "the healthy recipient was still delivered");
  assert.equal(marks.sent.length, 1);
  assert.equal(marks.retry.length, 1, "the broken one is queued for another try");
  assert.match(marks.retry[0].error, /550/);
});

test("a send that keeps failing is eventually marked failed, not retried forever", async () => {
  reset();
  dueRows = [row({ attempts: 20 })];
  sendMailImpl = async () => { throw new Error("SendGrid 401"); };

  const result = await runSweep();

  assert.equal(result.failed, 1);
  assert.equal(marks.failed.length, 1);
  assert.equal(marks.retry.length, 0);
  assert.match(marks.failed[0].error, /401/);
});

test("a vanished call row stops retrying instead of looping forever", async () => {
  reset();
  call = null; // resync deleted it
  dueRows = [row()];

  const result = await runSweep();

  assert.equal(result.failed, 1);
  assert.equal(sent.length, 0);
  assert.match(marks.failed[0].error, /no longer exists/i);
});

test("an empty queue is a cheap no-op", async () => {
  reset();
  dueRows = [];
  const result = await runSweep();
  assert.deepEqual(result, { claimed: 0, sent: 0, held: 0, failed: 0, errors: 0 });
  assert.equal(fetchCalls.length, 0);
});

// ── content ──────────────────────────────────────────────────────────────────

test("the subject is filterable against inbound and flags test calls", async () => {
  reset();
  dueRows = [row()];
  await runSweep();
  assert.ok(sent[0].subject.includes("Outbound"), sent[0].subject);
  assert.ok(sent[0].subject.includes("Confirmed"));
  assert.ok(sent[0].subject.includes("Ultimate Fire"));

  reset();
  call = baseCall({ is_test: true });
  dueRows = [row()];
  await runSweep();
  assert.ok(sent[0].subject.startsWith("[TEST]"), sent[0].subject);
});

test("the transcript is both inline and attached in full", async () => {
  reset();
  dueRows = [row()];
  await runSweep();

  assert.ok(sent[0].html.includes("Yes, that works"), "inline in the body");
  const txt = sent[0].attachments.find((a) => a.filename.endsWith(".txt"));
  assert.ok(txt.content.toString("utf8").includes("Yes, that works"), "and complete in the .txt");
});

test("a very long transcript is truncated inline but complete in the attachment", async () => {
  reset();
  const long = Array.from({ length: 900 }, (_, i) => `Agent: line ${i}\nUser: reply ${i}`).join("\n");
  call = baseCall({ transcript: long });
  dueRows = [row()];

  await runSweep();

  assert.ok(sent[0].html.includes("Transcript truncated"), "the body says it was cut");
  const txt = sent[0].attachments.find((a) => a.filename.endsWith(".txt"));
  assert.ok(txt.content.toString("utf8").includes("reply 899"), "the attachment keeps the tail");
});

// ── logging ──────────────────────────────────────────────────────────────────

test("the pipeline logs every step of a successful send", async () => {
  reset();
  dueRows = [row()];
  await runSweep();

  const lines = logger.records.info.map(([msg]) => String(msg));
  // The steps someone debugging "where did this email go?" needs to see.
  for (const step of ["sweep start", "1/6", "2/6", "3/6", "4/6", "5/6", "6/6", "sweep complete"]) {
    assert.ok(lines.some((l) => l.includes(step)), `a log line covers "${step}"`);
  }
  assert.ok(lines.every((l) => l.startsWith("[call-notification]")),
    "every line carries the prefix, so one grep pulls the whole pipeline");
});

test("every log line can be tied back to its conversation", async () => {
  reset();
  dueRows = [row()];
  await runSweep();

  // retellCallId is the correlation key — without it on the per-row lines you
  // cannot separate two conversations draining in the same sweep.
  // Steps 1-6 are per-conversation; step 0 (sweep start) covers the whole batch
  // and correctly has no single conversation to name.
  const perRow = logger.records.info.filter(([msg]) => /[1-6]\/6/.test(String(msg)));
  assert.ok(perRow.length > 0);
  assert.ok(perRow.every(([, meta]) => meta && meta.retellCallId === "call_abc"),
    "every numbered step names its conversation");
});

test("the signed recording URL never reaches the logs", async () => {
  reset();
  dueRows = [row()];
  await runSweep();

  // Same reasoning as keeping it out of the email: it is an unauthenticated
  // link to a customer conversation, and a log file is somewhere it would sit
  // indefinitely. Host + path is all that is useful for debugging.
  const allLogs = JSON.stringify(logger.records);
  assert.ok(!allLogs.includes("deadbeef"), "no signature in any log line");
  assert.ok(!allLogs.includes("sig="), "no query string at all");
});

test("recipient addresses are masked in the logs", async () => {
  reset();
  dueRows = [row({ email: "erica@ultimatefire.test" })];
  await runSweep();

  const allLogs = JSON.stringify(logger.records);
  assert.ok(!allLogs.includes("erica@ultimatefire.test"), "the full address is never logged");
  assert.ok(allLogs.includes("erica@***"), "but enough survives to tell recipients apart");
});

test("a held conversation logs why it held and when it will retry", async () => {
  reset();
  fetchResult = { status: "unavailable", buffer: null, contentType: null, ext: null, bytes: null,
                  reason: "Recording fetch returned HTTP 404" };
  dueRows = [row()];
  await runSweep();

  const hold = logger.records.info.find(([msg]) => /HOLDING/.test(String(msg)));
  assert.ok(hold, "the hold is called out, not silent");
  const [, meta] = hold;
  assert.match(meta.reason, /404/, "says why");
  assert.ok(meta.nextAttemptAt, "says when it comes back");
  assert.equal(meta.maxAttempts, 5, "says how much budget is left");
});

test("sending without audio is a WARN, not a silent info", async () => {
  reset();
  fetchResult = { status: "too_large", buffer: null, contentType: null, ext: null, bytes: 99e6,
                  reason: "Recording is 94.4 MB, over the 12 MB email limit" };
  dueRows = [row()];
  await runSweep();

  // This is the degraded outcome for a go-live blocker — it must be visible at
  // warn level, not buried among the info lines.
  assert.ok(logger.records.warn.some(([msg]) => /SENDING WITHOUT AUDIO/.test(String(msg))),
    "the degraded send is surfaced as a warning");
});

test("an idle sweep logs at debug, so a once-a-minute cron cannot flood info", async () => {
  reset();
  dueRows = [];
  await runSweep();

  assert.equal(logger.records.info.length, 0, "nothing at info level when there is no work");
  assert.ok(logger.records.debug.some(([msg]) => /nothing due/.test(String(msg))));
});
