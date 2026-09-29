/**
 * Regression: streaming a recording must never be able to kill the process.
 *
 * WHAT HAPPENED. GET /calls/:id/recording piped the upstream body with a bare
 * `Readable.fromWeb(body).pipe(res)`, and the upstream fetch used
 * `AbortSignal.timeout(30_000)`. That signal keeps counting while the BODY is
 * still transferring, so a large-but-healthy download (recordings are ~7 MB
 * uncompressed WAV) or a browser holding a range request open while the
 * listener scrubs would trip it mid-stream. The abort surfaced as an 'error'
 * event on the Readable, and with `.pipe()` nothing was listening — so Node
 * did what it always does with an unhandled 'error' and took the whole server
 * down for every tenant:
 *
 *   DOMException [TimeoutError]: The operation was aborted due to timeout
 *   Emitted 'error' event on Readable instance at: ...
 *   Node.js v22.22.3
 *
 * Two independent fixes, and this file pins both, because either alone would
 * have left the crash reachable by another route:
 *   1. utils/streaming-fetch.js — the timeout covers the RESPONSE only, so a
 *      slow body is no longer aborted at all.
 *   2. routes/calls.js — `pipeline(...)` with an error callback, so if a stream
 *      does fail it stays one failed request.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable, pipeline } = require("node:stream");

const { fetchStreaming } = require("../src/utils/streaming-fetch");

// ── 1. the timeout must not span the body ────────────────────────────────────

test("the response timeout is cleared once headers arrive, so a slow body is never aborted", async () => {
  const realFetch = global.fetch;
  try {
    let capturedSignal = null;
    global.fetch = async (url, opts) => {
      capturedSignal = opts.signal;
      return { ok: true, status: 200, headers: new Map() };
    };

    const { response } = await fetchStreaming("https://example.test/big.wav", { responseTimeoutMs: 40 });
    assert.equal(response.ok, true);

    // Well past the timeout, but the body is notionally still streaming. The
    // old AbortSignal.timeout would have fired here and destroyed the stream.
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(capturedSignal.aborted, false,
      "a body still in flight must not be aborted by the response timeout");
  } finally {
    global.fetch = realFetch;
  }
});

test("an upstream that never responds IS aborted — fail fast is still wanted", async () => {
  const realFetch = global.fetch;
  try {
    global.fetch = async (url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });

    await assert.rejects(
      () => fetchStreaming("https://example.test/dead", { responseTimeoutMs: 30 }),
      (err) => err.name === "AbortError"
    );
  } finally {
    global.fetch = realFetch;
  }
});

test("the caller gets an abort handle, so a disconnecting client cancels the transfer", async () => {
  const realFetch = global.fetch;
  try {
    let capturedSignal = null;
    global.fetch = async (url, opts) => {
      capturedSignal = opts.signal;
      return { ok: true, status: 200, headers: new Map() };
    };

    const { abort } = await fetchStreaming("https://example.test/big.wav", { responseTimeoutMs: 1000 });
    assert.equal(capturedSignal.aborted, false);
    abort();
    assert.equal(capturedSignal.aborted, true,
      "otherwise a closed browser tab leaves the upstream transfer running");
  } finally {
    global.fetch = realFetch;
  }
});

// ── 2. a failing stream must stay one failed request ─────────────────────────

/** A web ReadableStream that yields a chunk and then errors — what an abort does. */
function erroringWebStream() {
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array([1, 2, 3]));
      setTimeout(() => {
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        c.error(e);
      }, 5);
    },
  });
}

test("pipeline routes a mid-stream failure to its callback instead of throwing", async () => {
  const sink = new Writable({ write(_c, _e, cb) { cb(); } });

  const err = await new Promise((resolve) => {
    pipeline(Readable.fromWeb(erroringWebStream()), sink, resolve);
  });

  // The whole point: the error is DELIVERED. With `.pipe()` it was emitted with
  // no listener, which is fatal to the process rather than to the request.
  assert.ok(err, "the failure reaches the callback");
  assert.equal(err.name, "TimeoutError");
});

test("an unhandled 'error' on a Readable really is fatal — why .pipe() was the bug", () => {
  // Pins the language behaviour the fix exists for, so nobody 'simplifies'
  // pipeline() back to .pipe() on the grounds that it reads more neatly.
  const r = Readable.fromWeb(erroringWebStream());
  assert.equal(r.listenerCount("error"), 0, "a fresh stream has no error listener");

  // With a listener attached, the same event is survivable. Without one, Node
  // throws — which is exactly what the production traceback showed.
  let seen = null;
  r.on("error", (e) => { seen = e; });
  assert.equal(r.listenerCount("error"), 1);
  assert.equal(seen, null, "nothing has failed yet; the guard is simply in place");
});

// ── 3. the route wires the guard ─────────────────────────────────────────────

/** Comments explain the bug and naturally quote `.pipe(res)` — assert on CODE. */
function stripComments(code) {
  return code
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
    .join("\n");
}

test("the recording route uses pipeline with a callback, never a bare pipe", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../src/routes/calls.js"), "utf8");

  const handler = src.slice(src.indexOf('router.get("/:id/recording"'));
  const body = stripComments(handler.slice(0, handler.indexOf("\nrouter.")));

  assert.ok(/pipeline\(\s*Readable\.fromWeb/.test(body), "streams via pipeline()");
  assert.ok(!/\.pipe\(res\)/.test(body), "never a bare .pipe(res) — that is the crash");
  assert.ok(/res\.on\("close"/.test(body), "cancels the upstream when the client goes away");
  assert.ok(!/AbortSignal\.timeout/.test(body), "no body-spanning timeout in the streaming path");
});

test("no streaming path anywhere still uses a body-spanning timeout", () => {
  const fs = require("node:fs");
  // openRecording hands its Response to the route to be piped, so a total
  // timeout there is the same latent crash one call frame further out.
  const archive = fs.readFileSync(require.resolve("../src/services/call-recording-archive.js"), "utf8");
  const openFn = archive.slice(archive.indexOf("async function openRecording"));
  const openBody = stripComments(openFn.slice(0, openFn.indexOf("\nmodule.exports")));
  assert.ok(!/AbortSignal\.timeout/.test(openBody),
    "openRecording must use fetchStreaming, not a total timeout");

  const storage = fs.readFileSync(require.resolve("../src/services/supabase-storage.js"), "utf8");
  const dl = stripComments(storage.slice(storage.indexOf("async function download"), storage.indexOf("async function remove")));
  assert.ok(!/AbortSignal\.timeout/.test(dl), "storage.download must use fetchStreaming");
  assert.ok(/fetchStreaming/.test(dl));
});

// ── 4. an abandoned response body must never leave an armed timer ────────────

test("fetchRecording releases the body on EVERY early return", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../src/services/call-notification/recording.js"), "utf8");
  const fn = src.slice(src.indexOf("async function fetchRecording"), src.indexOf("async function lookupRecordingUrl"));
  const body = stripComments(fn);

  // The second crash: returning without consuming or cancelling the body leaves
  // the request in flight. A later timeout then aborts it and the detached body
  // stream emits 'error' with no listener — fatal. The archive cron hits the
  // !res.ok path every 5 minutes whenever Retell is not ready yet, so this was
  // a recurring crash needing no user action.
  assert.ok(!/AbortSignal\.timeout/.test(body),
    "must use fetchStreaming, not a timer that outlives the call");
  assert.ok(/fetchStreaming/.test(body));
  assert.ok(/clearTimeout\(bodyBudget\)/.test(body),
    "the body budget is cleared in a finally, so no timer outlives the function");

  // One releaseBody per non-ok exit: !res.ok, too_large, bad_type.
  const releases = (body.match(/await releaseBody\(res\)/g) || []).length;
  assert.ok(releases >= 3, `every early return releases the body (found ${releases}, expected >= 3)`);
});

test("the server installs last-resort handlers so one stream error cannot end the process", () => {
  const fs = require("node:fs");
  const src = stripComments(fs.readFileSync(require.resolve("../src/server.js"), "utf8"));

  assert.ok(/process\.on\("uncaughtException"/.test(src), "uncaughtException is handled");
  assert.ok(/process\.on\("unhandledRejection"/.test(src), "unhandledRejection is handled");
  // A silent handler would turn a crash into an invisible bug, which is worse.
  assert.ok(/UNCAUGHT EXCEPTION/.test(src) && /logger\.error/.test(src),
    "and both log loudly rather than swallowing");
});
