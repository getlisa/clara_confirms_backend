const express = require("express");
const { authenticate, getCompanyId } = require("../auth");
const analytics = require("../services/analytics");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

router.get("/stats", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const stats = await analytics.getStats(companyId, req.query.period);
    return res.json(stats);
  } catch (err) {
    logger.error("GET /dashboard/stats failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load dashboard stats" });
  }
});

module.exports = router;
