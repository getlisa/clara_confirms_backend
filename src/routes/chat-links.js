/**
 * Chat links — generate + resolve shareable, token-based links to a web chat
 * widget for a specific job/appointment.
 *
 * POST /chat-links/appointments/:id            — authenticated (staff), generates/reuses a link
 * POST /chat-links/jobs/:id                    — authenticated (staff), generates/reuses a link
 * POST /chat-links/appointments/:id/send-email — authenticated (staff), same as above + emails it
 * POST /chat-links/jobs/:id/send-email         — authenticated (staff), same as above + emails it
 * GET  /chat-links/:token                      — PUBLIC, no auth — the token IS the credential.
 *                                                 Opened by an anonymous customer's browser, so
 *                                                 CORS is intentionally opened wide for this one route.
 */

const express = require("express");
const cors = require("cors");
const { authenticate, getCompanyId } = require("../auth");
const chatLinksService = require("../services/chat-links");
const logger = require("../utils/logger");

const router = express.Router();

router.post("/appointments/:id", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const result = await chatLinksService.createChatLinkForAppointment(companyId, Number(req.params.id), callType);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    return res.status(201).json({ token: result.token });
  } catch (err) {
    logger.error("POST /chat-links/appointments/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create chat link" });
  }
});

router.post("/jobs/:id", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const result = await chatLinksService.createChatLinkForJob(companyId, Number(req.params.id), callType);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    return res.status(201).json({ token: result.token });
  } catch (err) {
    logger.error("POST /chat-links/jobs/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create chat link" });
  }
});

// "Send chat link" via email — creates/reuses the link (same as the plain
// POST above) and additionally emails it to the customer on file, for a
// button that actually delivers the link instead of just copying a URL.
router.post("/appointments/:id/send-email", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const overrideEmail = req.body?.email != null ? String(req.body.email) : null;
    const result = await chatLinksService.sendConfirmationEmailForAppointment(companyId, Number(req.params.id), callType, overrideEmail);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    return res.json(result);
  } catch (err) {
    logger.error("POST /chat-links/appointments/:id/send-email failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send confirmation email" });
  }
});

router.post("/jobs/:id/send-email", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const overrideEmail = req.body?.email != null ? String(req.body.email) : null;
    const result = await chatLinksService.sendConfirmationEmailForJob(companyId, Number(req.params.id), callType, overrideEmail);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    return res.json(result);
  } catch (err) {
    logger.error("POST /chat-links/jobs/:id/send-email failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send confirmation email" });
  }
});

// Same idea as send-email above, but texts the link via Twilio instead — a
// plain text with a link, NOT the conversational Retell "Text Now" feature.
router.post("/appointments/:id/send-sms", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const overridePhone = req.body?.phone != null ? String(req.body.phone) : null;
    const result = await chatLinksService.sendConfirmationSmsForAppointment(companyId, Number(req.params.id), callType, overridePhone);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    return res.json(result);
  } catch (err) {
    logger.error("POST /chat-links/appointments/:id/send-sms failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send confirmation sms" });
  }
});

router.post("/jobs/:id/send-sms", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const callType = req.body?.call_type || "customer_confirmation";
    const overridePhone = req.body?.phone != null ? String(req.body.phone) : null;
    const result = await chatLinksService.sendConfirmationSmsForJob(companyId, Number(req.params.id), callType, overridePhone);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });

    return res.json(result);
  } catch (err) {
    logger.error("POST /chat-links/jobs/:id/send-sms failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send confirmation sms" });
  }
});

// PUBLIC — no authenticate() call. Wide-open CORS scoped to this single route
// only (the app-level CORS in src/server.js stays restrictive for everything else).
const openCors = cors();
router.options("/:token", openCors);
router.get("/:token", openCors, async (req, res) => {
  try {
    const result = await chatLinksService.resolveChatLink(req.params.token);
    if (!result.ok) return res.status(result.status || 404).json({ error: result.error, ...(result.code && { code: result.code }) });
    return res.json(result);
  } catch (err) {
    logger.error("GET /chat-links/:token failed", { error: err.message });
    return res.status(500).json({ error: "Failed to resolve chat link" });
  }
});

// ── SSE message send ─────────────────────────────────────────────────────────
// The wire protocol is unchanged from the original Retell-backed version —
// `typing`, then `message_delta` chunks, then `message_complete`, then `done`
// with the updated state/input_hint — but the deltas are now REAL model
// tokens, streamed from the LangGraph run as they are generated, rather than
// the finished text sliced into 12-character ticks after the whole
// (multi-second, tool-calling) turn had already completed. The frontend needs
// no change; the wait before the first character just goes away.
//
// Emission is driven entirely by the onEvent callback below. The resolved
// `result.messages` carry the same content and must NOT also be written, or
// every reply would be sent twice.

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Proxies (and Vercel) drop an idle response; a turn can sit silent for tens
// of seconds while a tool runs, which is exactly the gap streaming was meant
// to make survivable. A comment line is ignored by every SSE client.
const HEARTBEAT_MS = 15000;

router.options("/:token/messages", openCors);
router.post("/:token/messages", openCors, async (req, res) => {
  const content = req.body?.content;
  if (typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ error: "content is required" });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    // Nginx buffers proxied responses by default, which would hold every
    // delta back until the turn ended — reinstating the old wait invisibly.
    "X-Accel-Buffering": "no",
  });
  // Node coalesces small writes by default; each SSE frame must go out on its
  // own or the deltas arrive in clumps.
  res.flushHeaders?.();
  if (typeof res.socket?.setNoDelay === "function") res.socket.setNoDelay(true);

  const heartbeat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
  // If the customer closes the tab mid-turn, stop writing into a dead socket.
  // The graph run itself is deliberately NOT aborted — its tool calls may
  // already have confirmed an appointment, and the checkpointer keeps the
  // reply for the transcript replay on their next visit.
  let aborted = false;
  // MUST be res, not req: since Node 16 the request's own "close" fires as
  // soon as its body has been fully read, which for a normal POST is
  // immediately — guarding on that silently truncated every reply after the
  // first chunk. The response closing before we end it is the real signal
  // that the customer went away.
  res.on("close", () => { if (!res.writableEnded) aborted = true; });

  // Time-to-first-token is the only number that says whether streaming
  // actually helped — total turn duration barely moves, since the same LLM
  // and tool calls still run. Measured from the moment the request is
  // accepted, so it includes link resolution and context hydration (the DB
  // work before the model is even called), which is what the customer feels.
  const startedAt = Date.now();
  let firstTokenMs = null;

  try {
    sseSend(res, "typing", {});

    // Defense in depth — every event in this stream must be role:"agent"
    // (the doc promises the customer's own message is never echoed back);
    // the real fix is upstream (the agent no longer includes it), but this
    // guards against any future regression too.
    const onEvent = (ev) => {
      if (aborted) return;
      if (ev.type === "delta") {
        if (firstTokenMs === null) firstTokenMs = Date.now() - startedAt;
        sseSend(res, "message_delta", { role: "agent", chunk: ev.chunk });
      } else if (ev.type === "message" && ev.message.role === "agent") {
        sseSend(res, "message_complete", ev.message);
      }
    };

    const result = await chatLinksService.sendChatMessage(req.params.token, content, onEvent);
    if (!result.ok) {
      sseSend(res, "error", { error: result.error });
      return res.end();
    }

    const totalMs = Date.now() - startedAt;
    logger.info("Chat turn streamed", { token: req.params.token, firstTokenMs, totalMs });
    // Also on the wire, so the timing is visible from the browser's network
    // tab without server log access — the frontend may ignore both fields.
    sseSend(res, "done", { state: result.state, input_hint: result.input_hint, first_token_ms: firstTokenMs, total_ms: totalMs });
    return res.end();
  } catch (err) {
    logger.error("POST /chat-links/:token/messages failed", { error: err.message });
    sseSend(res, "error", { error: "Failed to send message" });
    return res.end();
  } finally {
    clearInterval(heartbeat);
  }
});

module.exports = router;
