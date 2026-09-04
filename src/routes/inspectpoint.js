/**
 * InspectPoint integration routes.
 *
 * Auth is a static per-tenant API key + subdomain — no login/session, so this
 * is structurally simpler than routes/servicetrade.js: no /login stub, no
 * getSession/logout dance. The one thing ServiceTrade's routes don't need
 * that these do: a mutual-exclusivity check on connect (see POST /credentials)
 * — a company can only ever have one CRM connected, because both CRMs can
 * genuinely describe the same real-world job with no way to deduplicate them.
 */

const express = require("express");
const config = require("../config");
const { authenticate } = require("../auth/auth.middleware");
const ip = require("../services/inspectpoint");
const credentialsDb = require("../db/inspectpoint-credentials");
const syncDb = require("../db/inspectpoint-sync");
const stCredentialsDb = require("../db/servicetrade-credentials");
const crmSyncEngine = require("../engines/crm-sync");
const engineToken = require("../engines/core/token");
const enginesDb = require("../engines/core/db");
const { validateSyncRange } = require("../utils/sync-date-range");
const logger = require("../utils/logger");

const router = express.Router();

router.use(authenticate);

/**
 * POST /integrations/inspectpoint/credentials
 * Connect with a subdomain + API key. Verified with one cheap read
 * (GET /accounts?max=1) before saving — there is no dedicated auth endpoint.
 */
router.post("/credentials", async (req, res) => {
  const companyId = req.user.companyId;
  const { subdomain, apiKey, metadata } = req.body || {};

  if (!subdomain || !apiKey) {
    return res.status(400).json({ error: "subdomain and apiKey are required" });
  }

  try {
    // Only one CRM per company: both can genuinely describe the same
    // real-world job under different external_refs with no way to
    // deduplicate them, so running both silently doubles every job.
    const hasServiceTrade = await stCredentialsDb.hasCredentials(companyId);
    if (hasServiceTrade) {
      return res.status(409).json({
        connected: false,
        error: "ServiceTrade is already connected for this company. Disconnect it first.",
      });
    }

    const trimmedSubdomain = subdomain.trim();
    const verified = await ip.verifyCredentials(trimmedSubdomain, apiKey);
    if (!verified) {
      return res.status(403).json({ connected: false, error: "Invalid InspectPoint credentials" });
    }

    await credentialsDb.upsert(companyId, trimmedSubdomain, apiKey, metadata || null);
    return res.json({ connected: true, message: "Connected to InspectPoint" });
  } catch (err) {
    logger.error("InspectPoint credentials save error", { error: err.message });
    return res.status(500).json({
      error: "Failed to save credentials",
      detail: config.nodeEnv === "development" ? err.message : undefined,
    });
  }
});

// Same staleness rule as routes/servicetrade.js's buildSyncStatus — a run
// whose process died leaves engine_runs.status='running' forever, so a run
// with no event for this long is treated as dead on read, not on write.
const STALE_RUN_MS = 10 * 60 * 1000;

async function buildSyncStatus(companyId) {
  try {
    const [state, runs] = await Promise.all([
      syncDb.getSyncState(companyId).catch(() => null),
      enginesDb.listRuns({ companyId, kind: "crm_sync", limit: 1 }).catch(() => []),
    ]);
    const latest = runs[0] || null;
    const lastBeat = latest ? (latest.last_event_at || latest.started_at) : null;
    const stale = lastBeat ? Date.now() - new Date(lastBeat).getTime() > STALE_RUN_MS : false;
    const running = !!latest && latest.status === "running" && !stale;
    return {
      syncing: running,
      currentState: running ? latest.current_state : null,
      runId: running ? String(latest.id) : null,
      startedAt: running ? latest.started_at : null,
      lastRunAbandoned: !!latest && latest.status === "running" && stale,
      lastSyncAt: state?.last_sync_at ?? null,
      lastSyncStatus: state?.last_sync_status ?? null,
      lastSyncError: state?.last_sync_error ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * GET /integrations/inspectpoint/status
 * No session to check (unlike ServiceTrade) — "connected" just means a
 * credential row exists. A dead/revoked key surfaces on the next sync
 * attempt's error, not here.
 */
router.get("/status", async (req, res) => {
  const companyId = req.user.companyId;
  try {
    const creds = await credentialsDb.getByCompanyId(companyId);
    if (!creds) {
      return res.json({ connected: false, hasCredentials: false, message: "No InspectPoint connection. Connect with a subdomain and API key." });
    }
    return res.json({ connected: true, hasCredentials: true, sync: await buildSyncStatus(companyId) });
  } catch (err) {
    logger.error("InspectPoint status error", { error: err.message });
    return res.status(502).json({ connected: false, error: "InspectPoint request failed" });
  }
});

/**
 * DELETE /integrations/inspectpoint/session
 * Clears the stored API key; subdomain + metadata are preserved for a
 * one-click reconnect.
 */
router.delete("/session", async (req, res) => {
  const companyId = req.user.companyId;
  try {
    await credentialsDb.clearCredentials(companyId);
    return res.status(204).send();
  } catch (err) {
    logger.error("InspectPoint disconnect error", { error: err.message });
    return res.status(502).json({ error: "Failed to disconnect InspectPoint" });
  }
});

/**
 * Turn a validated {startDate, endDate} into the unix-second window
 * inspectpoint-sync.js's runSync expects. No company-timezone resolution —
 * InspectPoint's scheduled_date_start/end filter is a plain date with no
 * time-of-day component, the same convention the existing rolling
 * WINDOW_DAYS_BACK/FORWARD window already uses (see inspectpoint-sync.js),
 * so a custom range keeps that convention rather than inventing a new one.
 */
function utcDayBounds(startDate, endDate) {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  return {
    scheduleDateFrom: Math.floor(Date.UTC(sy, sm - 1, sd, 0, 0, 0) / 1000),
    scheduleDateTo: Math.floor(Date.UTC(ey, em - 1, ed, 23, 59, 59) / 1000),
  };
}

/**
 * POST /integrations/inspectpoint/sync?full=true&stream=true
 *      &startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Always prefer stream=true — see docs/inspectpoint-integration-frontend.md §4.4/§7.1
 * for why the blocking form is a trap for anything but a short incremental sync.
 *
 * startDate/endDate (both or neither, plain calendar dates, inclusive, at
 * most utils/sync-date-range.js's MAX_SYNC_RANGE_DAYS apart) replace the
 * default rolling inspections/visits window — e.g. backfilling a past month.
 * A custom window re-pulls that whole window rather than only what changed
 * since the last sync, and deliberately leaves last_jobs_updated_at
 * untouched (see inspectpoint-sync.js's runSync). Mutually exclusive with
 * full=true. Same contract as routes/servicetrade.js's equivalent.
 */
router.post("/sync", async (req, res) => {
  const companyId = req.user.companyId;
  const full = req.query.full === "true" || req.query.full === true;
  const stream = req.query.stream === "true" || req.query.stream === true;

  const { error: rangeError, startDate, endDate } = validateSyncRange({
    startDate: req.query.startDate ? String(req.query.startDate) : null,
    endDate:   req.query.endDate   ? String(req.query.endDate)   : null,
    full,
  });
  if (rangeError) return res.status(400).json({ error: rangeError });
  const { scheduleDateFrom, scheduleDateTo } = startDate ? utcDayBounds(startDate, endDate) : {};

  try {
    const hasCreds = await credentialsDb.getByCompanyId(companyId);
    if (!hasCreds) return res.status(400).json({ error: "InspectPoint not connected" });

    const engine = await crmSyncEngine.start({
      companyId, provider: "inspectpoint", full, startedBy: req.user.id,
      scheduleDateFrom, scheduleDateTo,
    });

    if (stream) {
      const streamToken = engineToken.sign({ runId: engine.id, companyId });
      return res.status(202).json({
        runId: String(engine.id),
        kind: engine.kind,
        streamToken,
        streamUrl: `/engines/${engine.id}/stream?token=${encodeURIComponent(streamToken)}`,
        snapshotUrl: `/engines/${engine.id}`,
      });
    }

    const finalRun = await waitForRun(engine.id);
    if (finalRun.status === "failed") {
      return res.status(400).json({ error: finalRun.error || "Sync failed" });
    }
    return res.json({ success: true, runId: String(engine.id), counts: finalRun.result || {} });
  } catch (err) {
    logger.error("InspectPoint sync route error", { error: err.message });
    return res.status(500).json({
      error: "Sync failed",
      detail: config.nodeEnv === "development" ? err.message : undefined,
    });
  }
});

async function waitForRun(runId, { timeoutMs = 4 * 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await enginesDb.getRun(runId);
    if (!run) throw new Error(`Engine run ${runId} not found`);
    if (run.status !== "running") return run;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Engine run ${runId} did not finish within ${timeoutMs}ms`);
}

// ── Raw list passthroughs — debug/browse view over the six inspectpoint_* tables ──

function rawListRoute(table, entityName, filterColumn = null, filterQueryParam = null) {
  return async (req, res) => {
    const companyId = req.user.companyId;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage, 10) || 50, 1), 200);
    const filterValue = filterQueryParam && req.query[filterQueryParam] ? Number(req.query[filterQueryParam]) : null;
    try {
      const { rows, total } = await syncDb.listRaw(table, companyId, {
        page, perPage,
        ...(filterColumn && filterValue != null ? { filterColumn, filterValue } : {}),
      });
      return res.json({ [entityName]: rows, pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) } });
    } catch (err) {
      logger.error(`InspectPoint ${entityName} list error`, { error: err.message });
      return res.status(500).json({ error: `Failed to list ${entityName}` });
    }
  };
}

router.get("/accounts", rawListRoute("inspectpoint_customers", "accounts"));
router.get("/buildings", rawListRoute("inspectpoint_locations", "buildings", "inspectpoint_customer_id", "accountId"));
router.get("/contacts", rawListRoute("inspectpoint_contacts", "contacts", "inspectpoint_customer_id", "accountId"));
router.get("/technicians", rawListRoute("inspectpoint_technicians", "technicians"));
router.get("/inspections", rawListRoute("inspectpoint_jobs", "inspections", "inspectpoint_location_id", "buildingId"));
router.get("/inspection-visits", rawListRoute("inspectpoint_appointments", "visits", "inspectpoint_job_id", "inspectionId"));

module.exports = router;
