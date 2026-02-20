/**
 * ServiceTrade integration routes
 * Credentials are stored per company in company_servicetrade table.
 * All routes require app authentication.
 */

const express = require("express");
const config = require("../config");
const { authenticate } = require("../auth/auth.middleware");
const servicetrade = require("../services/servicetrade");
const credentialsDb = require("../db/servicetrade-credentials");
const logger = require("../utils/logger");

const router = express.Router();

router.use(authenticate);

/**
 * POST /integrations/servicetrade/credentials
 * Save ServiceTrade username/password for the current user's company and connect.
 * Body: { username, password }
 */
router.post("/credentials", async (req, res) => {
  const companyId = req.user.companyId;
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      error: "Username and password are required",
    });
  }

  try {
    await credentialsDb.upsert(companyId, username.trim(), password);
    const result = await servicetrade.login(companyId, username.trim(), password);
    if (!result) {
      return res.status(403).json({
        connected: false,
        error: "Invalid ServiceTrade credentials",
        message: "Credentials were saved. Check username and password and try again.",
      });
    }
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
 * Log in using stored credentials for the company (no body).
 * Use after credentials are already saved via POST /credentials.
 */
router.post("/login", async (req, res) => {
  const companyId = req.user.companyId;

  try {
    const creds = await credentialsDb.getByCompanyId(companyId);
    if (!creds) {
      return res.status(400).json({
        error: "ServiceTrade credentials not configured for this company",
        detail: "Save credentials first via POST /integrations/servicetrade/credentials",
      });
    }

    const result = await servicetrade.login(companyId, creds.username, creds.password);
    if (!result) {
      return res.status(403).json({
        connected: false,
        error: "Invalid ServiceTrade credentials",
      });
    }
    return res.json({
      connected: true,
      user: result.user,
      message: "Successfully authenticated with ServiceTrade",
    });
  } catch (err) {
    logger.error("ServiceTrade login error", { error: err.message });
    return res.status(502).json({
      connected: false,
      error: "ServiceTrade request failed",
      detail: config.nodeEnv === "development" ? err.message : undefined,
    });
  }
});

/**
 * GET /integrations/servicetrade/status
 * Check current ServiceTrade connection for the company (uses stored creds if needed).
 */
router.get("/status", async (req, res) => {
  const companyId = req.user.companyId;

  try {
    let session = await servicetrade.getSession(companyId);
    if (session) {
      return res.json({
        connected: true,
        user: session.user,
        hasCredentials: true,
      });
    }

    const creds = await credentialsDb.getByCompanyId(companyId);
    if (!creds) {
      return res.json({
        connected: false,
        hasCredentials: false,
        message: "No ServiceTrade credentials saved. Connect with username and password.",
      });
    }

    const result = await servicetrade.login(companyId, creds.username, creds.password);
    if (result) {
      return res.json({
        connected: true,
        user: result.user,
        hasCredentials: true,
      });
    }

    return res.json({
      connected: false,
      hasCredentials: true,
      message: "Saved credentials are invalid. Update them to reconnect.",
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
 * Close current ServiceTrade session for the company (does not delete saved credentials).
 */
router.delete("/session", async (req, res) => {
  const companyId = req.user.companyId;

  try {
    await servicetrade.logout(companyId);
    return res.status(204).send();
  } catch (err) {
    logger.error("ServiceTrade logout error", { error: err.message });
    return res.status(502).json({
      error: "Failed to close ServiceTrade session",
    });
  }
});

module.exports = router;
