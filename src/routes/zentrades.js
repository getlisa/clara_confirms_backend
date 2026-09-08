/**
 * ZenTrades integration routes.
 *
 * Auth is username/password (a real login, no API key) — structurally closer
 * to ServiceTrade's connect flow than InspectPoint's, but the credential
 * itself is stored differently (encrypted password, not a session cookie —
 * see migrations/107_zentrades_integration.sql's header for why). Mutual
 * exclusivity now has to check BOTH other CRMs, not just one — a company can
 * only ever have one CRM connected, since any two can genuinely describe the
 * same real-world job with no way to deduplicate them.
 */

const express = require("express");
const config = require("../config");
const { authenticate } = require("../auth/auth.middleware");
const zt = require("../services/zentrades");
const credentialsDb = require("../db/zentrades-credentials");
const syncDb = require("../db/zentrades-sync");
const stCredentialsDb = require("../db/servicetrade-credentials");
const ipCredentialsDb = require("../db/inspectpoint-credentials");
const crmSyncEngine = require("../engines/crm-sync");
const engineToken = require("../engines/core/token");
const enginesDb = require("../engines/core/db");
const { validateSyncRange } = require("../utils/sync-date-range");
const logger = require("../utils/logger");

const router = express.Router();

router.use(authenticate);

/**
 * POST /integrations/zentrades/credentials
 * Connect with a username + password. Verified with a real login before
 * saving — see services/zentrades.js's verifyCredentials — since a bad
 * password should fail the connect attempt immediately, not surface on the
 * next cron tick.
 */
router.post("/credentials", async (req, res) => {
  const companyId = req.user.companyId;
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    // Only one CRM per company — see this file's header.
    const [hasServiceTrade, hasInspectPoint] = await Promise.all([
      stCredentialsDb.hasCredentials(companyId),
      ipCredentialsDb.hasCredentials(companyId),
    ]);
    if (hasServiceTrade) {
      return res.status(409).json({ connected: false, error: "ServiceTrade is already connected for this company. Disconnect it first." });
    }
    if (hasInspectPoint) {
      return res.status(409).json({ connected: false, error: "InspectPoint is already connected for this company. Disconnect it first." });
    }

    const trimmedUsername = username.trim();
    const verified = await zt.verifyCredentials(trimmedUsername, password);
    if (!verified.ok) {
      return res.status(403).json({ connected: false, error: "Invalid ZenTrades username or password" });
    }

    await credentialsDb.upsert(companyId, trimmedUsername, password, verified.metadata);
    // Cache the token we just minted from verification — saves the very
    // first sync run a redundant login.
    await credentialsDb.setAccessToken(companyId, verified.accessToken, verified.expiresAt).catch(() => {});
    return res.json({ connected: true, message: "Connected to ZenTrades" });
  } catch (err) {
    logger.error("ZenTrades credentials save error", { error: err.message });
    return res.status(500).json({
      error: "Failed to save credentials",
      detail: config.nodeEnv === "development" ? err.message : undefined,
    });
  }
});

// Same staleness rule as routes/inspectpoint.js's buildSyncStatus — a run
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
 * GET /integrations/zentrades/status
 * Includes authStatus/authFailedAt/authMessage on top of the shape the
 * other two CRMs return — see docs/zentrades-integration-frontend.md §2 for
 * why this is the one genuinely new UI state: a password that stops working
 * mid-connection, not just "connected" vs "not connected".
 */
router.get("/status", async (req, res) => {
  const companyId = req.user.companyId;
  try {
    const creds = await credentialsDb.getByCompanyId(companyId);
    if (!creds) {
      return res.json({ connected: false, hasCredentials: false, message: "No ZenTrades connection. Connect with a username and password." });
    }
    return res.json({
      connected: true,
      hasCredentials: true,
      authStatus: creds.authStatus,
      authFailedAt: creds.authFailedAt,
      authMessage: creds.authStatus === "ok" ? null : creds.authError,
      sync: await buildSyncStatus(companyId),
    });
  } catch (err) {
    logger.error("ZenTrades status error", { error: err.message });
    return res.status(502).json({ connected: false, error: "ZenTrades request failed" });
  }
});

/**
 * DELETE /integrations/zentrades/session
 * Clears the stored password; username + metadata are preserved for a
 * one-click reconnect (just re-enter the password).
 */
router.delete("/session", async (req, res) => {
  const companyId = req.user.companyId;
  try {
    await credentialsDb.clearCredentials(companyId);
    return res.status(204).send();
  } catch (err) {
    logger.error("ZenTrades disconnect error", { error: err.message });
    return res.status(502).json({ error: "Failed to disconnect ZenTrades" });
  }
});

/**
 * Turn a validated {startDate, endDate} into the unix-second window
 * zentrades-sync.js's runSync expects. Day-boundary UTC instants, same
 * convention as InspectPoint's utcDayBounds — ZenTrades' own filter takes
 * full ISO timestamps (unlike InspectPoint's date-only filter), but a
 * day-boundary instant is exactly what a "sync this calendar range" request
 * means either way, so there's no reason to invent a different convention.
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
 * POST /integrations/zentrades/sync?full=true&stream=true
 *      &startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 * Always prefer stream=true. startDate/endDate (both or neither, plain
 * calendar dates, inclusive, at most MAX_SYNC_RANGE_DAYS apart, mutually
 * exclusive with full=true) replace the default rolling schedule window —
 * e.g. backfilling a past month. A custom window re-pulls that whole window
 * and deliberately leaves every sync-state stamp untouched (see
 * services/zentrades-sync.js's runSync). Same contract shape as the other
 * two CRMs' sync routes.
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
    if (!hasCreds) return res.status(400).json({ error: "ZenTrades not connected" });
    if (hasCreds.authStatus !== "ok") {
      return res.status(400).json({ error: `ZenTrades re-authentication required (${hasCreds.authStatus}). Reconnect with the current password.` });
    }

    const engine = await crmSyncEngine.start({
      companyId, provider: "zentrades", full, startedBy: req.user.id,
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
    logger.error("ZenTrades sync route error", { error: err.message });
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

// ── Raw list passthroughs — debug/browse view over the seven zentrades_* tables ──

function rawListRoute(table, entityName, filterColumn = null, filterQueryParam = null) {
  return async (req, res) => {
    const companyId = req.user.companyId;
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const perPage = Math.min(Math.max(parseInt(req.query.perPage, 10) || 50, 1), 200);
    const filterValue = filterQueryParam && req.query[filterQueryParam] ? req.query[filterQueryParam] : null;
    try {
      const { rows, total } = await syncDb.listRaw(table, companyId, {
        page, perPage,
        ...(filterColumn && filterValue != null ? { filterColumn, filterValue } : {}),
      });
      return res.json({ [entityName]: rows, pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) } });
    } catch (err) {
      logger.error(`ZenTrades ${entityName} list error`, { error: err.message });
      return res.status(500).json({ error: `Failed to list ${entityName}` });
    }
  };
}

router.get("/tickets", rawListRoute("zentrades_tickets", "tickets"));
router.get("/appointments", rawListRoute("zentrades_appointments", "appointments", "zentrades_ticket_id", "ticketId"));
router.get("/customers", rawListRoute("zentrades_customers", "customers"));
router.get("/locations", rawListRoute("zentrades_locations", "locations", "zentrades_customer_id", "customerId"));
router.get("/technicians", rawListRoute("zentrades_technicians", "technicians"));
router.get("/contacts", rawListRoute("zentrades_contacts", "contacts", "zentrades_customer_id", "customerId"));
router.get("/recurrences", rawListRoute("zentrades_recurrences", "recurrences", "zentrades_ticket_id", "ticketId"));

module.exports = router;
