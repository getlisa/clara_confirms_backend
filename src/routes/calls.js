const express = require("express");
const callsDb = require("../db/calls");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

/**
 * GET /calls
 * Query params: status, appointment_confirmed, limit, offset
 */
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { status, appointment_confirmed, limit, offset, is_test } = req.query;
    const calls = await callsDb.list(companyId, {
      status: status || undefined,
      appointmentConfirmed: appointment_confirmed || undefined,
      limit: limit ? Math.min(Number(limit), 200) : 50,
      offset: offset ? Number(offset) : 0,
      isTest: is_test === "true",
    });
    return res.json({ calls });
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
    return res.json({ call });
  } catch (err) {
    logger.error("GET /calls/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load call" });
  }
});

module.exports = router;
