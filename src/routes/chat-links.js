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

module.exports = router;
