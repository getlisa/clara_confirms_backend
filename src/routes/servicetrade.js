/**
 * ServiceTrade integration routes
 * Stores auth_code (session token) per company only; password is never stored.
 * All routes require app authentication.
 */

const express = require("express");
const config = require("../config");
const { authenticate } = require("../auth/auth.middleware");
const servicetrade = require("../services/servicetrade");
const crm = require("../services/crm");
const credentialsDb = require("../db/servicetrade-credentials");
const syncDb = require("../db/servicetrade-sync");
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
    await credentialsDb.upsert(companyId, username.trim(), result.cookie, metadata);
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
 * GET /integrations/servicetrade/status
 * Check connection using stored auth_code (no password). If token invalid, user must connect again.
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
 * POST /integrations/servicetrade/sync?full=true
 * Run full or incremental sync. full=true forces full sync and resets last_sync_at.
 */
router.post("/sync", async (req, res) => {
  const companyId = req.user.companyId;
  const full = req.query.full === "true" || req.query.full === true;

  try {
    const provider = crm.getProvider("servicetrade");
    const result = await provider.syncAll(companyId, { full });
    if (!result.ok) {
      return res.status(400).json({ error: result.error, counts: result.counts });
    }
    return res.json({ success: true, counts: result.counts });
  } catch (err) {
    logger.error("ServiceTrade sync route error", { error: err.message });
    return res.status(500).json({
      error: "Sync failed",
      detail: config.nodeEnv === "development" ? err.message : undefined,
    });
  }
});

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

module.exports = router;
