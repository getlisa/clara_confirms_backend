/**
 * ServiceTrade integration routes
 * Stores auth_code (session token) per company only; password is never stored.
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
    await credentialsDb.upsert(companyId, username.trim(), result.authToken, metadata);
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

module.exports = router;
