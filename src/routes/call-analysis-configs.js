const express = require("express");
const callAnalysisConfigsDb = require("../db/call-analysis-configs");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

// GET /call-analysis-configs — all 5 outcome configs for this company
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const configs = await callAnalysisConfigsDb.getByCompanyId(companyId);
    return res.json({ call_analysis_configs: configs });
  } catch (err) {
    logger.error("GET /call-analysis-configs failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load configs" });
  }
});

// PATCH /call-analysis-configs/:type — update priority or enabled for one outcome
router.patch("/:type", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { priority, enabled } = req.body;

    if (priority !== undefined && !["high", "medium", "low"].includes(priority))
      return res.status(400).json({ error: "priority must be 'high', 'medium', or 'low'" });
    if (enabled !== undefined && typeof enabled !== "boolean")
      return res.status(400).json({ error: "enabled must be a boolean" });

    const updated = await callAnalysisConfigsDb.upsert(companyId, req.params.type, { priority, enabled });
    return res.json({ call_analysis_config: updated });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logger.error("PATCH /call-analysis-configs/:type failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update config" });
  }
});

module.exports = router;
