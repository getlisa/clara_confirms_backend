/**
 * Chat links — generate + resolve shareable, token-based links to a web chat
 * widget for a specific job/appointment.
 *
 * POST /chat-links/appointments/:id  — authenticated (staff), generates/reuses a link
 * POST /chat-links/jobs/:id          — authenticated (staff), generates/reuses a link
 * GET  /chat-links/:token            — PUBLIC, no auth — the token IS the credential.
 *                                       Opened by an anonymous customer's browser, so
 *                                       CORS is intentionally opened wide for this one route.
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

// PUBLIC — no authenticate() call. Wide-open CORS scoped to this single route
// only (the app-level CORS in src/server.js stays restrictive for everything else).
const openCors = cors();
router.options("/:token", openCors);
router.get("/:token", openCors, async (req, res) => {
  try {
    const result = await chatLinksService.resolveChatLink(req.params.token);
    if (!result.ok) return res.status(result.status || 404).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    logger.error("GET /chat-links/:token failed", { error: err.message });
    return res.status(500).json({ error: "Failed to resolve chat link" });
  }
});

// ── SSE message send ─────────────────────────────────────────────────────────
// Retell's chat completion has no token-level streaming — this simulates a
// typing feel: a `typing` event immediately, then the real (multi-second,
// tool-calling) completion round-trip, then the resulting text revealed in
// small chunks, then a `done` event carrying the updated state/input_hint.
const CHUNK_SIZE = 12; // characters per message_delta tick — small enough to feel like typing

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

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
  });

  try {
    sseSend(res, "typing", {});

    const result = await chatLinksService.sendChatMessage(req.params.token, content);
    if (!result.ok) {
      sseSend(res, "error", { error: result.error });
      return res.end();
    }

    for (const message of result.messages) {
      const text = message.content || "";
      for (let i = 0; i < text.length; i += CHUNK_SIZE) {
        sseSend(res, "message_delta", { role: message.role, chunk: text.slice(i, i + CHUNK_SIZE) });
      }
      sseSend(res, "message_complete", message);
    }

    sseSend(res, "done", { state: result.state, input_hint: result.input_hint });
    return res.end();
  } catch (err) {
    logger.error("POST /chat-links/:token/messages failed", { error: err.message });
    sseSend(res, "error", { error: "Failed to send message" });
    return res.end();
  }
});

module.exports = router;
