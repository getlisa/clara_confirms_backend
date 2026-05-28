const express = require("express");
const todosDb = require("../db/todos");
const { authenticate, getCompanyId, getUserId, requireRole } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();

router.use(authenticate);

/**
 * GET /todos
 * Query params: status, type, assigned_to, limit, offset
 */
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { status, type, assigned_to, limit, offset, is_test } = req.query;
    const todos = await todosDb.list(companyId, {
      status: status || undefined,
      type: type || undefined,
      assignedTo: assigned_to ? Number(assigned_to) : undefined,
      limit: limit ? Math.min(Number(limit), 200) : 50,
      offset: offset ? Number(offset) : 0,
      isTest: is_test === "false",
    });
    return res.json({ todos });
  } catch (err) {
    logger.error("GET /todos failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load todos" });
  }
});

/**
 * PATCH /todos/:id/status
 * Body: { status, notes }
 */
router.patch("/:id/status", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { status, notes } = req.body;
    const validStatuses = ["open", "in_progress", "resolved", "dismissed"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${validStatuses.join(", ")}` });
    }

    const todo = await todosDb.updateStatus(Number(req.params.id), companyId, {
      status,
      notes,
      actorId: getUserId(req),
    });
    if (!todo) return res.status(404).json({ error: "Todo not found" });
    return res.json({ todo });
  } catch (err) {
    logger.error("PATCH /todos/:id/status failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update todo" });
  }
});

/**
 * PATCH /todos/:id/assign
 * Body: { assigned_to }  (user id)
 * Admin only
 */
router.patch("/:id/assign", requireRole("admin"), async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { assigned_to } = req.body;
    if (!assigned_to) return res.status(400).json({ error: "assigned_to is required" });

    const todo = await todosDb.assign(Number(req.params.id), companyId, {
      assignedTo: Number(assigned_to),
      actorId: getUserId(req),
    });
    if (!todo) return res.status(404).json({ error: "Todo not found" });
    return res.json({ todo });
  } catch (err) {
    logger.error("PATCH /todos/:id/assign failed", { error: err.message });
    return res.status(500).json({ error: "Failed to assign todo" });
  }
});

/**
 * GET /todos/:id/logs
 */
router.get("/:id/logs", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const logs = await todosDb.getLogs(Number(req.params.id), companyId);
    return res.json({ logs });
  } catch (err) {
    logger.error("GET /todos/:id/logs failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load todo logs" });
  }
});

module.exports = router;
