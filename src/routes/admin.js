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
const webhookProcessor = require("../services/servicetrade-webhook-processor");
const webhooksDb = require("../db/servicetrade-webhooks");
const chatLinksDb = require("../db/chat-links");
const { runSweep: runDailyReportSweep } = require("../services/daily-report/send");
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
    // Reap first: gcOldRuns deliberately skips status='running', so an
    // abandoned run would otherwise never be cleaned up OR deleted. Marking
    // it failed here both corrects status reporting now and makes it eligible
    // for deletion on a later pass.
    const staleMinutes = Math.max(parseInt(req.query.staleMinutes, 10) || 30, 1);
    const reaped = await enginesDb.reapStaleRuns(staleMinutes);
    const deleted = await enginesDb.gcOldRuns(days);
    logger.info("Admin: engine_runs GC", { days, deleted, staleMinutes, reaped });
    return res.json({ ok: true, days, deleted, staleMinutes, reaped });
  } catch (err) {
    logger.error("Admin engines/gc failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/servicetrade-webhooks/drain — apply queued ServiceTrade webhook
// events for every company that has any. Wired to an every-minute Vercel cron:
// the receiving endpoint only has 5 seconds to answer before ServiceTrade
// retries, so it does nothing but enqueue, and this is what actually applies
// the changes. Without this cron the queue simply fills up.
//
// `router.all` because Vercel cron sends GET while a manual poke uses POST.
router.all("/servicetrade-webhooks/drain", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await webhookProcessor.drainAll();
    // Only worth a log line when something happened — this runs 1,440 times a day.
    if (result.companies > 0) logger.info("Admin: ServiceTrade webhook drain", result);
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("Admin servicetrade-webhooks/drain failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/chat-links/backfill-outcome-comments — one-off catch-up.
//
// The sweep can only act on links at the moment they expire; anything that
// expired before that code existed is already status='expired' and invisible to
// it. Observed live: link 69 confirmed an appointment and its confirmation never
// reached ServiceTrade.
//
// Optional ?companyId= to scope the first run, and ?limit= (default 200).
// Posting is still gated per company by crm_comment_writeback_enabled.
router.all("/chat-links/backfill-outcome-comments", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const companyId = req.query.companyId ? Number(req.query.companyId) : null;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
    const links = await chatLinksDb.listExpiredAwaitingOutcomeComment({ companyId, limit });

    const confirmationAgent = require("../confirmation-agent");
    const results = { considered: links.length, posted: 0, no_outcome: 0, errors: 0, details: [] };
    for (const link of links) {
      const r = await confirmationAgent
        .postExpiredOutcomeComment({ companyId: link.company_id, jobId: link.job_id, token: link.token })
        .catch((err) => ({ posted: false, reason: "error", error: err.message }));
      if (r.posted) results.posted += 1;
      else if (r.reason === "error") results.errors += 1;
      else results.no_outcome += 1;
      results.details.push({ chat_link_id: link.id, company_id: link.company_id, ...r });
    }
    logger.info("Admin: chat-link outcome-comment backfill", { companyId, ...results, details: undefined });
    return res.json({ ok: true, ...results });
  } catch (err) {
    logger.error("Admin chat-links/backfill-outcome-comments failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/servicetrade-webhooks/gc — retention sweep for the event queue.
// Rides the existing hourly GC slot rather than adding another cron.
router.all("/servicetrade-webhooks/gc", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const deleted = await webhooksDb.purgeOld({
      doneOlderThanDays: Math.max(parseInt(req.query.doneDays, 10) || 7, 1),
      failedOlderThanDays: Math.max(parseInt(req.query.failedDays, 10) || 30, 1),
    });
    logger.info("Admin: ServiceTrade webhook queue GC", { deleted });
    return res.json({ ok: true, deleted });
  } catch (err) {
    logger.error("Admin servicetrade-webhooks/gc failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// POST /admin/reports/daily-sweep — evaluate every enabled report recipient
// across every company and send whoever is due right now. Wired to a
// 15-minute Vercel cron; `resolveDue` (services/daily-report/schedule.js) is
// what makes repeated/late runs safe — a recipient already sent for their
// target business date is a no-op, and a run that was down when the moment
// passed still catches up once it recovers.
router.all("/reports/daily-sweep", async (req, res) => {
  if (!verifyCronSecret(req, res)) return;
  try {
    const result = await runDailyReportSweep();
    if (result.sent > 0 || result.errors > 0) logger.info("Admin: daily report sweep", { ...result, details: undefined });
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("Admin reports/daily-sweep failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
