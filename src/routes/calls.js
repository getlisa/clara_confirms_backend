const express = require("express");
const callsDb = require("../db/calls");
const { authenticate, getCompanyId } = require("../auth");
const streamToken = require("../engines/core/token");
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
 */
router.get("/:id/recording", async (req, res) => {
  const callId = Number(req.params.id);
  const claim = streamToken.verify(String(req.query.token || ""));

  if (!claim || claim.runId !== String(callId)) {
    return res.status(401).json({ error: "Invalid or expired recording token" });
  }

  try {
    const url = await callsDb.getRecordingUrl(callId, claim.companyId);
    if (!url) return res.status(404).json({ error: "No recording for this call" });

    // Range is forwarded so the browser can seek rather than re-downloading.
    const upstream = await fetch(url, {
      headers: req.headers.range ? { Range: req.headers.range } : {},
      signal: AbortSignal.timeout(30000),
    });
    if (!upstream.ok && upstream.status !== 206) {
      logger.warn("GET /calls/:id/recording: upstream refused", { callId, status: upstream.status });
      return res.status(502).json({ error: "Recording is not available right now" });
    }

    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/wav");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    for (const header of ["content-length", "content-range"]) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }

    // Node 18+ can consume a web ReadableStream directly via Readable.fromWeb.
    const { Readable } = require("stream");
    Readable.fromWeb(upstream.body).pipe(res);
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
