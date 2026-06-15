/**
 * AI Copilot routes.
 *
 *   POST /copilot/conversations                       → create a conversation (JWT)
 *   GET  /copilot/conversations                       → list conversations (JWT)
 *   GET  /copilot/conversations/:id                   → message history (JWT)
 *   POST /copilot/conversations/:id/messages          → send a message → start a turn (JWT)
 *   POST /copilot/conversations/:id/confirm           → confirm/reject a pending write (JWT)
 *   GET  /copilot/runs/:runId/stream?token=<signed>   → SSE stream for a turn (token auth)
 *
 * Streaming mirrors the engines transport: POST returns a short-lived signed
 * streamToken bound to (runId, companyId); the browser EventSource passes it as
 * ?token=... since it can't set Authorization headers.
 */

const express = require("express");
const { authenticate, getCompanyId, getUserId } = require("../auth");
const sse = require("../engines/core/sse");
const token = require("../engines/core/token");
const copilot = require("../copilot");
const persistence = require("../copilot/persistence");
const logger = require("../utils/logger");

const router = express.Router();

const MAX_MESSAGE_LEN = 4000;

// ── Create conversation ────────────────────────────────────────────────────
router.post("/conversations", authenticate, async (req, res) => {
  try {
    const conv = await persistence.createConversation(
      getCompanyId(req),
      getUserId(req),
      req.body?.title || null
    );
    return res.status(201).json({ id: String(conv.id), thread_id: conv.thread_id, title: conv.title });
  } catch (err) {
    logger.error("POST /copilot/conversations failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create conversation" });
  }
});

// ── List conversations ─────────────────────────────────────────────────────
router.get("/conversations", authenticate, async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 30;
  const rows = await persistence.listConversations(getCompanyId(req), { limit });
  return res.json({ conversations: rows.map((r) => ({ ...r, id: String(r.id) })) });
});

// ── Conversation history ───────────────────────────────────────────────────
router.get("/conversations/:id", authenticate, async (req, res) => {
  try {
    const conv = await persistence.getConversation(req.params.id, getCompanyId(req));
    if (!conv) return res.status(404).json({ error: "Conversation not found" });
    const messages = await copilot.getHistory(conv.thread_id);
    return res.json({
      id: String(conv.id),
      thread_id: conv.thread_id,
      title: conv.title,
      messages,
    });
  } catch (err) {
    logger.error("GET /copilot/conversations/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load conversation" });
  }
});

// ── Send a message → start a streaming turn ────────────────────────────────
router.post("/conversations/:id/messages", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const conv = await persistence.getConversation(req.params.id, companyId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
    if (!message) return res.status(400).json({ error: "message is required" });
    if (message.length > MAX_MESSAGE_LEN) {
      return res.status(400).json({ error: `message exceeds ${MAX_MESSAGE_LEN} characters` });
    }

    const engine = await copilot.start({
      companyId,
      userId: getUserId(req),
      conversationId: conv.id,
      threadId: conv.thread_id,
      message,
    });

    return res.status(201).json(streamResponse(engine));
  } catch (err) {
    logger.error("POST /copilot/conversations/:id/messages failed", { error: err.message });
    return res.status(500).json({ error: "Failed to start copilot turn", detail: err.message });
  }
});

// ── Confirm / reject a pending write action ────────────────────────────────
router.post("/conversations/:id/confirm", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    const conv = await persistence.getConversation(req.params.id, companyId);
    if (!conv) return res.status(404).json({ error: "Conversation not found" });

    const { pendingActionId } = req.body || {};
    const decision = req.body?.decision === "confirm" ? "confirm" : "reject";
    if (!pendingActionId) return res.status(400).json({ error: "pendingActionId is required" });

    const pending = await persistence.getPendingAction(pendingActionId, companyId);
    if (!pending || pending.thread_id !== conv.thread_id) {
      return res.status(404).json({ error: "Pending action not found" });
    }
    if (pending.status !== "pending") {
      return res.status(409).json({ error: `Pending action already ${pending.status}` });
    }
    if (new Date(pending.expires_at).getTime() < Date.now()) {
      await persistence.setPendingActionStatus(pendingActionId, companyId, "expired");
      return res.status(410).json({ error: "Pending action expired" });
    }
    // Only the most recent proposal on a thread is resumable (one interrupt at a time).
    const latest = await persistence.getLatestPendingForThread(conv.thread_id, companyId);
    if (!latest || String(latest.id) !== String(pendingActionId)) {
      return res.status(409).json({ error: "A newer pending action supersedes this one" });
    }

    const engine = await copilot.resume({
      companyId,
      userId: getUserId(req),
      conversationId: conv.id,
      threadId: conv.thread_id,
      pendingActionId,
      decision,
    });

    return res.status(201).json(streamResponse(engine));
  } catch (err) {
    logger.error("POST /copilot/conversations/:id/confirm failed", { error: err.message });
    return res.status(500).json({ error: "Failed to resolve pending action", detail: err.message });
  }
});

// ── SSE stream for a turn ──────────────────────────────────────────────────
// Not behind `authenticate` — uses the signed query-string token (EventSource
// can't send Authorization headers).
router.get("/runs/:runId/stream", async (req, res) => {
  const claim = token.verify(String(req.query.token || ""));
  if (!claim) return res.status(401).json({ error: "Invalid or expired stream token" });
  if (String(claim.runId) !== String(req.params.runId)) {
    return res.status(403).json({ error: "Token does not match runId" });
  }
  return sse.streamRun(req, res, { runId: req.params.runId, companyId: claim.companyId });
});

function streamResponse(engine) {
  const streamToken = token.sign({ runId: engine.id, companyId: engine.companyId });
  return {
    runId: String(engine.id),
    streamToken,
    streamUrl: `/copilot/runs/${engine.id}/stream?token=${encodeURIComponent(streamToken)}`,
  };
}

module.exports = router;
