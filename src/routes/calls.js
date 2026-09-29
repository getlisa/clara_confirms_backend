const express = require("express");
const callsDb = require("../db/calls");
const { authenticate, getCompanyId } = require("../auth");
const streamToken = require("../engines/core/token");
const { openRecording } = require("../services/call-recording-archive");
const logger = require("../utils/logger");
const { getCompanyTimezone, localizeRows, localizeFields } = require("../utils/timezone");

const router = express.Router();

const CALL_TZ_FIELDS = ["created_at", "updated_at"];

/**
 * GET /calls/:id/recording — stream the call recording to an <audio> element.
 *
 * Mounted BEFORE router.use(authenticate) and authorised by a signed
 * query-string token instead, because an HTML5 <audio> element cannot set an
 * Authorization header. Same problem and same solution as the SSE stream in
 * routes/engines.js, reusing its token module: the claim is bound to
 * (callId, companyId) with a 30-minute TTL.
 *
 * The point of proxying rather than handing the frontend Retell's own URL is
 * that the URL is unauthenticated — anyone holding it can replay a customer
 * conversation. It never leaves this process.
 *
 * Served from OUR archived copy when we have one, falling back to Retell only
 * while the archive sweep has not caught up yet (see
 * services/call-recording-archive.js). Once a call is archived, playback no
 * longer depends on Retell at all.
 */
router.get("/:id/recording", async (req, res) => {
  const callId = Number(req.params.id);
  const claim = streamToken.verify(String(req.query.token || ""));

  if (!claim || claim.runId !== String(callId)) {
    return res.status(401).json({ error: "Invalid or expired recording token" });
  }

  try {
    const src = await callsDb.getRecordingSource(callId, claim.companyId);
    if (!src) return res.status(404).json({ error: "Call not found" });

    // A purged recording is answered distinctly from a missing one: it is gone
    // for good, and the UI should say so rather than show a retry affordance.
    if (src.purgedAt && !src.storagePath) {
      return res.status(410).json({
        error: "This recording has been deleted under the retention policy",
        recording_state: "purged",
        purged_at: src.purgedAt,
      });
    }
    if (!src.storagePath && !src.retellUrl) {
      return res.status(404).json({ error: "No recording for this call", recording_state: "pending" });
    }

    // Range is forwarded so the browser can seek rather than re-downloading.
    const { source, response: upstream, abort } = await openRecording({
      storagePath: src.storagePath,
      retellUrl: src.retellUrl,
      purgedAt: src.purgedAt,
      range: req.headers.range || null,
    });
    if (!upstream) {
      logger.warn("GET /calls/:id/recording: no source could be opened", { callId });
      return res.status(502).json({ error: "Recording is not available right now" });
    }

    res.status(upstream.status);
    // Lets ops see whether playback came from our bucket or still leans on Retell.
    res.setHeader("X-Recording-Source", source);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    for (const header of ["content-length", "content-range"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    // A listener who closes the tab or skips to another call leaves the upstream
    // transfer running otherwise — each one holding a socket and, on Retell's
    // side, bandwidth we are paying for.
    res.on("close", () => { if (!res.writableEnded) abort(); });

    // `pipeline`, NOT `source.pipe(res)`.
    //
    // This is the line that crashed the server. A bare .pipe() leaves the source
    // stream's 'error' event unhandled, and Node throws on an unhandled 'error'
    // — taking the whole process down rather than failing one request:
    //
    //   DOMException [TimeoutError]: The operation was aborted due to timeout
    //   Emitted 'error' event on Readable instance at: ...
    //
    // pipeline() routes errors to its callback and destroys both ends, so a
    // failed transfer stays a failed transfer. The timeout that triggered it is
    // fixed separately in utils/streaming-fetch.js.
    const { pipeline, Readable } = require("stream");
    pipeline(Readable.fromWeb(upstream.body), res, (err) => {
      if (!err) return;
      // Expected and uninteresting: the client went away mid-stream, which is
      // exactly what happens every time someone pauses or navigates.
      const clientGone = ["ERR_STREAM_PREMATURE_CLOSE", "ECONNRESET", "EPIPE", "ABORT_ERR"].includes(err.code);
      if (clientGone) {
        logger.debug("GET /calls/:id/recording: client disconnected mid-stream", { callId, code: err.code });
        return;
      }
      logger.error("GET /calls/:id/recording: stream failed", { callId, source, error: err.message, code: err.code });
      // Headers are long gone by now, so there is no status left to send —
      // destroying the socket is the only honest signal of a truncated body.
      if (!res.headersSent) res.status(502).json({ error: "Recording stream failed" });
      else res.destroy(err);
    });
  } catch (err) {
    logger.error("GET /calls/:id/recording failed", { callId, error: err.message });
    if (!res.headersSent) res.status(500).json({ error: "Failed to stream recording" });
  }
});

// Everything below is JWT-authenticated as usual.
router.use(authenticate);

/**
 * GET /calls
 * Query params: status, appointment_confirmed, limit, offset
 */
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { status, appointment_confirmed, limit, offset, is_test, search } = req.query;
    const calls = await callsDb.list(companyId, {
      status: status || undefined,
      appointmentConfirmed: appointment_confirmed || undefined,
      limit: limit ? Math.min(Number(limit), 200) : 50,
      offset: offset ? Number(offset) : 0,
      isTest: is_test === "true",
      // Free-text over recipient phone / email / location / customer name.
      // Without it the Logs search box could only filter rows already fetched,
      // so a customer whose last activity fell outside the window read as
      // "no activity" rather than "not in this page".
      search: search ? String(search) : null,
    });
    const tz = await getCompanyTimezone(companyId);
    return res.json({ calls: localizeRows(calls, tz, CALL_TZ_FIELDS) });
  } catch (err) {
    logger.error("GET /calls failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load calls" });
  }
});

/**
 * GET /calls/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const call = await callsDb.getById(Number(req.params.id), companyId);
    if (!call) return res.status(404).json({ error: "Call not found" });
    const tz = await getCompanyTimezone(companyId);

    // A ready-to-use <audio src> for the player. Signed and short-lived, so the
    // frontend must re-read the call rather than caching this URL.
    if (call.has_recording) {
      const token = streamToken.sign({ runId: String(call.id), companyId });
      call.recording_stream_url = `/calls/${call.id}/recording?token=${encodeURIComponent(token)}`;
    }

    return res.json({ call: localizeFields(call, tz, CALL_TZ_FIELDS) });
  } catch (err) {
    logger.error("GET /calls/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load call" });
  }
});

module.exports = router;
