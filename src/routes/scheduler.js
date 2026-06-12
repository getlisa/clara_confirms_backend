const express = require("express");
const { runDispatcher, runDailyJob } = require("../services/scheduler");
const schedulerEngine = require("../engines/scheduler-run");
const engineToken = require("../engines/core/token");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");
const router = express.Router();

function verifyCronSecret(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization;
  logger.info("Cron secret", { auth, secret });
  if (!auth || auth !== `Bearer ${secret}`) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}

// Accept both GET and POST — Vercel cron always sends GET, manual triggers use POST
router.all("/run", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await runDispatcher();
    logger.info("Dispatcher run complete", result);
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("Dispatcher failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// Accept both GET and POST — Vercel cron always sends GET, manual triggers use POST
router.all("/daily", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await runDailyJob();
    logger.info("Daily job complete", result);
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("Daily job failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── Manual triggers (authenticated, scoped to user's company) ────────────────
// These bypass the per-company auto_* toggles so the user can fire on demand
// even when their company has the system cron disabled for that action.

router.post("/daily/manual", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    // Streaming mode: start an engine and return runId+token so the FE can subscribe.
    if (req.query.stream === "true" || req.query.stream === true) {
      const engine = await schedulerEngine.start({
        companyId, respectAutoFlag: false, startedBy: req.user?.id ?? null,
      });
      const streamToken = engineToken.sign({ runId: engine.id, companyId });
      return res.status(202).json({
        runId:       String(engine.id),
        kind:        engine.kind,
        streamToken,
        streamUrl:   `/engines/${engine.id}/stream?token=${encodeURIComponent(streamToken)}`,
        snapshotUrl: `/engines/${engine.id}`,
      });
    }

    // Legacy blocking mode — keep old contract.
    const result = await runDailyJob({ companyId, respectAutoFlag: false });
    logger.info("Manual daily job complete", { companyId, ...result });
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("Manual daily job failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.post("/run/manual", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const result = await runDispatcher(10, { companyId, respectAutoFlag: false });
    logger.info("Manual dispatcher run complete", { companyId, ...result });
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("Manual dispatcher run failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
