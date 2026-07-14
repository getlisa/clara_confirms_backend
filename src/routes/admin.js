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
const stEntityTypesDb = require("../db/servicetrade-entity-types");
const { registerToolsForAllCompanies } = require("../services/retell-tools");
const { syncFlowForCompany } = require("../services/retell-flow");
const db = require("../db");
const {
  resetDefaultPromptsForAllCompanies,
  syncPromptsForAllCompanies,
} = require("../services/prompt-sync");
const crmRegistry = require("../services/crm");
const enginesDb = require("../engines/core/db");
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
    await stEntityTypesDb.seedAll();
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

// POST /admin/crm-sync — iterate every active company with a CRM integration,
// run each provider's syncAll. Used by the daily Vercel cron and as a manual
// trigger. Optional ?provider=servicetrade to scope to one CRM.
//
// Iterates per (company × provider) pair so future BuildOps/ServiceTitan plug in
// automatically as long as they register a provider and have credentials.
// `router.all` so Vercel cron's GET requests match (manual triggers use POST).
router.all("/crm-sync", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const requestedProvider = req.query.provider ? String(req.query.provider) : null;
    const slugs = requestedProvider
      ? [requestedProvider]
      : crmRegistry.listProviders();

    if (slugs.length === 0) {
      logger.info("Admin crm-sync: no providers registered");
      return res.json({ ok: true, byProvider: {} });
    }

    const byProvider = {};
    for (const slug of slugs) {
      let provider;
      try { provider = crmRegistry.getProvider(slug); }
      catch (err) {
        byProvider[slug] = { error: err.message };
        continue;
      }

      // Find companies that have a credential row for this provider.
      // ServiceTrade uses `servicetrade_integration` — future CRMs will follow
      // the `<slug>_integration` convention. Generalize when we add another.
      const credTable = `${slug}_integration`;
      let companies = [];
      try {
        const { rows } = await db.query(
          `SELECT company_id FROM ${credTable}
           WHERE is_active = true AND auth_code IS NOT NULL AND auth_code <> ''`
        );
        companies = rows.map(r => Number(r.company_id));
      } catch (err) {
        logger.warn(`Admin crm-sync: ${credTable} not queryable — skipping ${slug}`, { error: err.message });
        byProvider[slug] = { error: `credential table missing: ${credTable}` };
        continue;
      }

      const perCompany = [];
      for (const companyId of companies) {
        try {
          const r = await provider.syncAll(companyId);
          perCompany.push({ companyId, ok: r.ok, counts: r.counts, error: r.error, incomplete: r.incomplete || [] });
        } catch (err) {
          logger.error("Admin crm-sync: company failed", { provider: slug, companyId, error: err.message });
          perCompany.push({ companyId, ok: false, error: err.message });
        }
      }
      byProvider[slug] = { companies: perCompany.length, results: perCompany };
    }

    logger.info("Admin: CRM sync complete", { providers: slugs, byProvider });
    return res.json({ ok: true, byProvider });
  } catch (err) {
    logger.error("Admin crm-sync failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/engines/gc — delete engine_runs older than ?days=30 (default).
// Wired to a Vercel cron so the table doesn't grow forever.
router.all("/engines/gc", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const days = Math.max(parseInt(req.query.days, 10) || 30, 1);
    const deleted = await enginesDb.gcOldRuns(days);
    logger.info("Admin: engine_runs GC", { days, deleted });
    return res.json({ ok: true, days, deleted });
  } catch (err) {
    logger.error("Admin engines/gc failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
