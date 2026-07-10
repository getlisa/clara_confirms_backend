/**
 * Onboarding routes — server-side new-company setup (replaces the frontend's
 * step-by-step orchestration).
 *
 * POST /onboarding        🔒 admin — run the full setup (company profile, agent,
 *                          call settings, campaigns, awaited Retell provision, invites).
 * GET  /onboarding/status 🔒       — per-step readiness + completion.
 */

const express = require("express");
const { runOnboarding, getOnboardingStatus } = require("../services/onboarding");
const { authenticate, getCompanyId, getUserId, requireRole } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const result = await runOnboarding(companyId, req.body || {}, getUserId(req));
    return res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    logger.error("POST /onboarding failed", { error: err.message });
    return res.status(500).json({ error: "Failed to run onboarding" });
  }
});

router.get("/status", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const status = await getOnboardingStatus(companyId);
    return res.json({ status });
  } catch (err) {
    logger.error("GET /onboarding/status failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load onboarding status" });
  }
});

module.exports = router;
