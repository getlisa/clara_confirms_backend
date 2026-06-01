/**
 * One-off admin actions, protected by CRON_SECRET.
 * Used to run maintenance jobs from anywhere (e.g. after a Vercel deploy):
 *
 *   curl -X POST https://clara-confirms-backend.vercel.app/admin/sync-tools \
 *     -H "Authorization: Bearer $CRON_SECRET"
 */
const express = require("express");
const toolDefsDb = require("../db/tool-definitions");
const dynamicVarsDb = require("../db/dynamic-variable-definitions");
const { registerToolsForAllCompanies } = require("../services/retell-tools");
const { syncFlowForCompany } = require("../services/retell-flow");
const db = require("../db");
const {
  resetDefaultPromptsForAllCompanies,
  syncPromptsForAllCompanies,
} = require("../services/prompt-sync");
const logger = require("../utils/logger");

const router = express.Router();

function verifyCronSecret(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// POST /admin/sync-tools — reseed catalog + register tools on all flows
router.post("/sync-tools", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    await toolDefsDb.seedAll();
    await dynamicVarsDb.seedAll();
    const result = await registerToolsForAllCompanies();
    logger.info("Admin: tools synced", result);
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("Admin sync-tools failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/sync-flows — re-provision every company's Retell flow + agent.
// Use after an env change (e.g. webhook URL) to push the current env's webhook_url
// to every Retell agent. Idempotent.
router.post("/sync-flows", async (_req, res) => {
  if (!verifyCronSecret(_req, res)) return;
  try {
    const { rows } = await db.query(
      `SELECT id, name FROM companies
       WHERE (is_active = true OR is_active IS NULL)
         AND retell_agent_id IS NOT NULL`
    );
    const results = [];
    for (const co of rows) {
      try {
        const r = await syncFlowForCompany(co.id);
        results.push({ companyId: co.id, ok: true, agentId: r?.agentId });
      } catch (err) {
        logger.error("Admin sync-flows: company failed", { companyId: co.id, error: err.message });
        results.push({ companyId: co.id, ok: false, error: err.message });
      }
    }
    logger.info("Admin: flows synced", { count: results.length });
    return res.json({ ok: true, results });
  } catch (err) {
    logger.error("Admin sync-flows failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/sync-prompts?reset=true — sync prompts (optionally reset to code defaults first)
router.post("/sync-prompts", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const reset = req.query.reset === "true";
    let resetResult = null;
    if (reset) resetResult = await resetDefaultPromptsForAllCompanies(null);
    const syncResult = await syncPromptsForAllCompanies(null);
    logger.info("Admin: prompts synced", { reset: !!reset, resetResult, syncResult });
    return res.json({ ok: true, reset: !!reset, ...syncResult, resetUpdated: resetResult?.total ?? null });
  } catch (err) {
    logger.error("Admin sync-prompts failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
