/**
 * ServiceTrade integration routes
 * Stores auth_code (session token) per company only; password is never stored.
 * All routes require app authentication.
 */

const express = require("express");
const config = require("../config");
const { authenticate } = require("../auth/auth.middleware");
const servicetrade = require("../services/servicetrade");
const crmSyncEngine = require("../engines/crm-sync");
const engineToken = require("../engines/core/token");
const enginesDb = require("../engines/core/db");
const credentialsDb = require("../db/servicetrade-credentials");
const syncDb = require("../db/servicetrade-sync");
const { syncAccountTimezone } = require("../services/servicetrade-account");
const webhookRegistration = require("../services/servicetrade-webhook-registration");
const webhookProcessor = require("../services/servicetrade-webhook-processor");
const logger = require("../utils/logger");

const router = express.Router();

router.use(authenticate);

/**
 * POST /integrations/servicetrade/credentials
 * Log in to ServiceTrade with username/password (password not stored), save auth_code and connect.
 * Body: { username, password, metadata? } — on reconnect, metadata is merged with existing.
 */
router.post("/credentials", async (req, res) => {
  const companyId = req.user.companyId;
  const { username, password, metadata } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      error: "Username and password are required",
    });
  }

  try {
    const result = await servicetrade.login(companyId, username.trim(), password);
    if (!result) {
      return res.status(403).json({
        connected: false,
        error: "Invalid ServiceTrade credentials",
      });
    }
    // Store the full Cookie header value (e.g. "PHPSESSID=abc") in auth_code.
    // This survives indefinitely until ServiceTrade invalidates the session.
    // Also capture the ServiceTrade user id — needed to mint a service-link
    // token via GET /api/token?jobId=&userId= (see chat-links get_service_link tool).
    const mergedMetadata = { ...(metadata || {}), servicetrade_user_id: result.user?.id ?? null };
    await credentialsDb.upsert(companyId, username.trim(), result.cookie, mergedMetadata);

    // Best-effort: adopt the CRM's own timezone as this company's default_timezone
    // so all scheduling/dispatch calculations use it. Never fails the connect request.
    syncAccountTimezone(companyId).catch((err) => {
      logger.warn("ServiceTrade connect: account timezone sync failed", { companyId, error: err.message });
    });

    return res.json({
      connected: true,
      user: result.user,
      message: "Connected to ServiceTrade",
    });
  } catch (err) {
    logger.error("ServiceTrade credentials save error", { error: err.message });
    return res.status(500).json({
      error: "Failed to save credentials",
      detail: config.nodeEnv === "development" ? err.message : undefined,
    });
  }
});

/**
 * POST /integrations/servicetrade/login
 * Cannot re-login without password; password is not stored. Use POST /credentials with username and password to connect.
 */
router.post("/login", async (req, res) => {
  return res.status(400).json({
    error: "Password is not stored. Use POST /credentials with username and password to connect.",
  });
});

/**
 * Sync state for the status response: whether one is running right now, and
 * how the last one ended.
 *
 * This exists because the platform is READABLE MID-SYNC — nothing wraps the
 * sync in a transaction, so each batch commits as it goes and rows appear
 * progressively. Without this, a client that loads during a sync sees a
 * partially-populated account with no way to tell "still importing" from
 * "this is everything", which reads as data loss.
 *
 * `syncing` comes from engine_runs rather than servicetrade_sync_state
 * because sync_state is only written when a run *finishes* — an in-flight (or
 * killed) run leaves no trace there.
 *
 * Best-effort: a failure here must not take down the connection check that is
 * this endpoint's actual job.
 */

// A run whose process died leaves engine_runs.status = 'running' forever —
// nothing writes a terminal status on a hard kill (Vercel freezing the
// instance, the 300s function cap, a crash). The daily GC cron reaps those,
// but "daily" means a dead run reports syncing = true for up to ~24h, and
// clients are told to suppress empty states while syncing — so complete data
// hides behind a permanent "Importing…". Observed in production: run 252 sat
// in `normalizing` for over two hours after its process was gone.
//
// So don't trust `running` on its own: a run that has not recorded ANY
// progress for this long is treated as dead on read. Compared against the last
// event, not started_at — a genuinely slow sync keeps emitting state/fetched/
// entity_done events, so it never trips this, while a dead one goes silent
// immediately. The row is left alone (the GC cron owns writes); this only
// affects what we report.
const STALE_RUN_MS = 10 * 60 * 1000;

async function buildSyncStatus(companyId) {
  try {
    const [state, runs] = await Promise.all([
      syncDb.getSyncState(companyId).catch(() => null),
      enginesDb.listRuns({ companyId, kind: "crm_sync", limit: 1 }).catch(() => []),
    ]);
    const latest = runs[0] || null;
    const lastBeat = latest ? (latest.last_event_at || latest.started_at) : null;
    const stale = lastBeat ? (Date.now() - new Date(lastBeat).getTime()) > STALE_RUN_MS : false;
    const running = !!latest && latest.status === "running" && !stale;
    return {
      syncing: running,
      currentState: running ? latest.current_state : null,   // e.g. "normalizing"
      runId: running ? String(latest.id) : null,
      startedAt: running ? latest.started_at : null,
      // Surfaced so a client can say "last sync was interrupted" instead of
      // silently showing stale-but-complete-looking data.
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
 * GET /integrations/servicetrade/status
 * Check connection using stored auth_code (no password). If token invalid, user must connect again.
 * Also reports sync progress so a client can tell partial data from complete data.
 */
router.get("/status", async (req, res) => {
  const companyId = req.user.companyId;

  try {
    const creds = await credentialsDb.getByCompanyId(companyId);
    if (!creds) {
      return res.json({
        connected: false,
        hasCredentials: false,
        message: "No ServiceTrade connection. Connect with username and password.",
      });
    }

    const session = await servicetrade.getSession(companyId, creds.authCode);
    if (session) {
      return res.json({
        connected: true,
        user: session.user,
        hasCredentials: true,
        sync: await buildSyncStatus(companyId),
      });
    }

    return res.json({
      connected: false,
      hasCredentials: false,
      message: "Session expired or invalid. Connect again with username and password.",
    });
  } catch (err) {
    logger.error("ServiceTrade status error", { error: err.message });
    return res.status(502).json({
      connected: false,
      error: "ServiceTrade request failed",
      detail: config.nodeEnv === "development" ? err.message : undefined,
    });
  }
});

/**
 * DELETE /integrations/servicetrade/session
 * Close ServiceTrade session and clear stored username and auth_code; metadata is preserved.
 */
router.delete("/session", async (req, res) => {
  const companyId = req.user.companyId;

  try {
    const creds = await credentialsDb.getByCompanyId(companyId);
    if (creds) {
      await servicetrade.logout(companyId, creds.authCode);
    }
    await credentialsDb.clearCredentials(companyId);
    return res.status(204).send();
  } catch (err) {
    logger.error("ServiceTrade logout error", { error: err.message });
    return res.status(502).json({
      error: "Failed to close ServiceTrade session",
    });
  }
});

/**
 * POST /integrations/servicetrade/sync?full=true&range=week|month|3month
 * Run full or incremental sync. full=true forces full sync and resets last_sync_at.
 * range controls the /servicerequest fetch window (default month).
 */
router.post("/sync", async (req, res) => {
  const companyId = req.user.companyId;
  const full = req.query.full === "true" || req.query.full === true;
  const stream = req.query.stream === "true" || req.query.stream === true;
  const range = ["week", "month", "3month"].includes(req.query.range) ? req.query.range : "month";

  try {
    const engine = await crmSyncEngine.start({
      companyId, provider: "servicetrade", full, range, startedBy: req.user.id,
    });

    // Streaming mode: return runId + token immediately so the FE can subscribe
    // to the SSE feed. Used by the new workflow-engine UI.
    if (stream) {
      const streamToken = engineToken.sign({ runId: engine.id, companyId });
      return res.status(202).json({
        runId:       String(engine.id),
        kind:        engine.kind,
        streamToken,
        streamUrl:   `/engines/${engine.id}/stream?token=${encodeURIComponent(streamToken)}`,
        snapshotUrl: `/engines/${engine.id}`,
      });
    }

    // Blocking mode (legacy contract): wait for the run to terminate and
    // return the final counts. Old clients keep working unchanged.
    const finalRun = await waitForRun(engine.id);
    if (finalRun.status === "failed") {
      return res.status(400).json({ error: finalRun.error || "Sync failed" });
    }
    return res.json({ success: true, runId: String(engine.id), counts: finalRun.result || {} });
  } catch (err) {
    logger.error("ServiceTrade sync route error", { error: err.message });
    return res.status(500).json({
      error: "Sync failed",
      detail: config.nodeEnv === "development" ? err.message : undefined,
    });
  }
});

/**
 * Poll engine_runs until the run is terminal. Backwards-compat helper for the
 * blocking sync contract — the engine itself runs async in the background.
 */
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

/**
 * GET /integrations/servicetrade/customers
 * List synced ServiceTrade customers (raw rows from servicetrade_customers).
 * Query: includeInactive=true|false (default false), page, perPage (max 200).
 */
router.get("/customers", async (req, res) => {
  const companyId = req.user.companyId;
  const includeInactive = req.query.includeInactive === "true";
  const page    = Math.max(parseInt(req.query.page, 10)    || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.perPage, 10) || 50, 1), 200);

  try {
    const { rows, total } = await syncDb.listCustomers(companyId, { includeInactive, page, perPage });
    return res.json({
      customers: rows,
      pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) },
    });
  } catch (err) {
    logger.error("ServiceTrade customers list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list customers" });
  }
});

/**
 * GET /integrations/servicetrade/jobs
 * List synced ServiceTrade jobs. Query: customerId (ServiceTrade customer id), page, perPage.
 */
router.get("/jobs", async (req, res) => {
  const companyId = req.user.companyId;
  const customerId = req.query.customerId ? Number(req.query.customerId) : null;
  const page    = Math.max(parseInt(req.query.page, 10)    || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.perPage, 10) || 50, 1), 200);

  try {
    const jobs = await syncDb.listJobs(companyId, { customerId, page, perPage });
    return res.json({ jobs });
  } catch (err) {
    logger.error("ServiceTrade jobs list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list jobs" });
  }
});

/**
 * GET /integrations/servicetrade/appointments
 * List synced ServiceTrade appointments. Query: jobId (ServiceTrade job id), page, perPage.
 */
router.get("/appointments", async (req, res) => {
  const companyId = req.user.companyId;
  const jobId = req.query.jobId ? Number(req.query.jobId) : null;
  const page    = Math.max(parseInt(req.query.page, 10)    || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.perPage, 10) || 50, 1), 200);

  try {
    const appointments = await syncDb.listAppointments(companyId, { jobId, page, perPage });
    return res.json({ appointments });
  } catch (err) {
    logger.error("ServiceTrade appointments list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list appointments" });
  }
});

/**
 * GET /integrations/servicetrade/technicians
 * List synced ServiceTrade technicians. Query: includeInactive=true|false.
 */
router.get("/technicians", async (req, res) => {
  const companyId = req.user.companyId;
  const includeInactive = req.query.includeInactive === "true";

  try {
    const technicians = await syncDb.listTechnicians(companyId, { includeInactive });
    return res.json({ technicians });
  } catch (err) {
    logger.error("ServiceTrade technicians list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list technicians" });
  }
});

/**
 * GET /integrations/servicetrade/locations
 * List synced ServiceTrade locations (raw rows from servicetrade_locations).
 * Query: includeInactive=true|false (default false), page, perPage (max 200).
 */
router.get("/locations", async (req, res) => {
  const companyId = req.user.companyId;
  const includeInactive = req.query.includeInactive === "true";
  const page    = Math.max(parseInt(req.query.page, 10)    || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.perPage, 10) || 50, 1), 200);

  try {
    const { rows, total } = await syncDb.listLocations(companyId, { includeInactive, page, perPage });
    return res.json({
      locations: rows,
      pagination: { page, perPage, total, totalPages: Math.max(Math.ceil(total / perPage), 1) },
    });
  } catch (err) {
    logger.error("ServiceTrade locations list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list locations" });
  }
});

/**
 * GET /integrations/servicetrade/contacts
 * List synced ServiceTrade contacts (raw rows, sourced from locations' embedded primaryContact).
 */
router.get("/contacts", async (req, res) => {
  const companyId = req.user.companyId;
  try {
    const contacts = await syncDb.listContacts(companyId);
    return res.json({ contacts });
  } catch (err) {
    logger.error("ServiceTrade contacts list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list contacts" });
  }
});

/**
 * GET /integrations/servicetrade/offices
 * List synced ServiceTrade offices (raw rows, sourced from locations' embedded offices[]).
 */
router.get("/offices", async (req, res) => {
  const companyId = req.user.companyId;
  const includeInactive = req.query.includeInactive === "true";
  try {
    const offices = await syncDb.listOffices(companyId, { includeInactive });
    return res.json({ offices });
  } catch (err) {
    logger.error("ServiceTrade offices list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list offices" });
  }
});

/**
 * GET /integrations/servicetrade/tags
 * List synced ServiceTrade tags (raw rows, sourced from locations' embedded tags[]).
 */
router.get("/tags", async (req, res) => {
  const companyId = req.user.companyId;
  try {
    const tags = await syncDb.listTags(companyId);
    return res.json({ tags });
  } catch (err) {
    logger.error("ServiceTrade tags list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list tags" });
  }
});

/**
 * GET /integrations/servicetrade/service-requests
 * List synced ServiceTrade service requests (raw rows from servicetrade_service_requests).
 * Query: status, page, perPage.
 */
router.get("/service-requests", async (req, res) => {
  const companyId = req.user.companyId;
  const status  = req.query.status || null;
  const page    = Math.max(parseInt(req.query.page, 10)    || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.perPage, 10) || 50, 1), 200);

  try {
    const serviceRequests = await syncDb.listServiceRequests(companyId, { status, page, perPage });
    return res.json({ service_requests: serviceRequests });
  } catch (err) {
    logger.error("ServiceTrade service requests list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list service requests" });
  }
});

// ── Webhooks ────────────────────────────────────────────────────────────────
// Realtime push alongside the hourly poll, which is unchanged and remains the
// correctness backstop (ServiceRequest is not webhookable, and ServiceTrade
// discards a message after 3 failed delivery attempts).
//
// The RECEIVING endpoint is not here — it is public, at
// POST /webhooks/servicetrade/:secret, because ServiceTrade cannot send a JWT.

// GET /integrations/servicetrade/webhook — local registration + ServiceTrade's
// own view of it + the queue depth.
router.get("/webhook", async (req, res) => {
  try {
    const result = await webhookRegistration.status(req.user.companyId);
    return res.json(result);
  } catch (err) {
    logger.error("ServiceTrade webhook status error", { error: err.message });
    return res.status(500).json({ error: "Failed to read webhook status" });
  }
});

// POST /integrations/servicetrade/webhook — create or repoint the subscription.
// Idempotent: re-posting updates the existing subscription instead of adding a
// second one (ServiceTrade would then deliver every message twice).
router.post("/webhook", async (req, res) => {
  try {
    const result = await webhookRegistration.register(req.user.companyId, {
      // Override only for testing against a tunnel; production uses PUBLIC_API_URL.
      baseUrl: req.body?.base_url || undefined,
      includeChangesets: req.body?.include_changesets !== false,
    });
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    logger.error("ServiceTrade webhook register error", { error: err.message });
    return res.status(500).json({ error: "Failed to register webhook" });
  }
});

router.delete("/webhook", async (req, res) => {
  try {
    const result = await webhookRegistration.unregister(req.user.companyId);
    if (!result.ok) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
  } catch (err) {
    logger.error("ServiceTrade webhook unregister error", { error: err.message });
    return res.status(500).json({ error: "Failed to remove webhook" });
  }
});

// POST /integrations/servicetrade/webhook/drain — apply this company's queued
// events now. Backs a "refresh" button: the every-minute cron already does this,
// so this is for a user who does not want to wait for the next tick.
//
// Scoped to the caller's own company, and safe to hammer — claimPending uses
// FOR UPDATE SKIP LOCKED, so a concurrent cron tick and ten impatient clicks
// cannot process the same event twice.
router.post("/webhook/drain", async (req, res) => {
  try {
    const result = await webhookProcessor.drainCompany(req.user.companyId);
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("ServiceTrade webhook drain error", { companyId: req.user.companyId, error: err.message });
    return res.status(500).json({ error: "Failed to apply queued webhook events" });
  }
});

module.exports = router;
