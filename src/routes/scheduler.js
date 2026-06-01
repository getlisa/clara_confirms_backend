const express = require("express");
const { runDispatcher, runDailyJob } = require("../services/scheduler");
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

router.post("/run", async (req, res) => {
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

router.post("/daily", async (req, res) => {
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

module.exports = router;
