/**
 * ServiceTrade integration routes
 * Stores auth_code (session token) per company only; password is never stored.
 * All routes require app authentication.
 */

const express = require("express");
const config = require("../config");
const { authenticate } = require("../auth/auth.middleware");
const servicetrade = require("../services/servicetrade");
const servicetradeSync = require("../services/servicetrade-sync");
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

/**
 * POST /integrations/servicetrade/sync?full=true
 * Run full or incremental sync. full=true forces full sync and resets last_sync_at.
 */
router.post("/sync", async (req, res) => {
  const companyId = req.user.companyId;
  const full = req.query.full === "true" || req.query.full === true;

  try {
    const result = await servicetradeSync.runSync(companyId, { full });
    if (!result.success) {
      return res.status(400).json({ error: result.error });
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
 * List ST companies (customers). Query: includeInactive=true to include inactive.
 */
router.get("/customers", async (req, res) => {
  const companyId = req.user.companyId;
  const includeInactive = req.query.includeInactive === "true";
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const perPage = Math.min(Math.max(parseInt(req.query.perPage, 10) || 50, 1), 200);

  try {
    const { rows, total } = await syncDb.listCompanies(companyId, includeInactive, page, perPage);
    const stCompanyIds = rows.map((r) => Number(r.servicetrade_id));
    const locationCounts = await syncDb.countLocationsByStCompanyBulk(companyId, stCompanyIds);
    const withCounts = rows.map((r) => ({
      ...r,
      location_count: locationCounts.get(Number(r.servicetrade_id)) || 0,
    }));
    return res.json({
      customers: withCounts,
      pagination: {
        page,
        perPage,
        total,
        totalPages: Math.max(Math.ceil(total / perPage), 1),
      },
    });
  } catch (err) {
    logger.error("ServiceTrade customers list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list customers" });
  }
});

/**
 * GET /integrations/servicetrade/customers/:servicetradeCompanyId/locations
 * List locations for one ST company. Query: includeInactive=true.
 */
router.get("/customers/:servicetradeCompanyId/locations", async (req, res) => {
  const companyId = req.user.companyId;
  const servicetradeCompanyId = parseInt(req.params.servicetradeCompanyId, 10);
  const includeInactive = req.query.includeInactive === "true";

  if (Number.isNaN(servicetradeCompanyId)) {
    return res.status(400).json({ error: "Invalid company id" });
  }

  try {
    const locations = await syncDb.listLocationsByStCompany(companyId, servicetradeCompanyId, includeInactive);
    const locationIds = locations.map((loc) => Number(loc.id));
    const srCounts = await syncDb.countServiceRequestsByLocationBulk(locationIds);
    const withCounts = locations.map((loc) => ({
      ...loc,
      service_request_count: srCounts.get(Number(loc.id)) || 0,
    }));
    return res.json({ locations: withCounts });
  } catch (err) {
    logger.error("ServiceTrade locations list error", { error: err.message });
    return res.status(500).json({ error: "Failed to list locations" });
  }
});

/**
 * GET /integrations/servicetrade/customers/:servicetradeCompanyId/detail
 * Company detail: company info + locations each with address, contacts, service_requests.
 */
router.get("/customers/:servicetradeCompanyId/detail", async (req, res) => {
  const companyId = req.user.companyId;
  const servicetradeCompanyId = parseInt(req.params.servicetradeCompanyId, 10);
  const includeInactive = req.query.includeInactive === "true";

  if (Number.isNaN(servicetradeCompanyId)) {
    return res.status(400).json({ error: "Invalid company id" });
  }

  try {
    const company = await syncDb.getStCompanyById(companyId, servicetradeCompanyId);
    if (!company) {
      return res.status(404).json({ error: "Company not found" });
    }
    const locations = await syncDb.listLocationsByStCompany(companyId, servicetradeCompanyId, includeInactive);
    const locationsWithDetail = await Promise.all(
      locations.map(async (loc) => {
        const [contacts, service_requests] = await Promise.all([
          syncDb.listContactsByLocation(companyId, loc.id),
          syncDb.listServiceRequestsByLocation(companyId, loc.id),
        ]);
        return { ...loc, contacts, service_requests };
      })
    );
    return res.json({ company, locations: locationsWithDetail });
  } catch (err) {
    logger.error("ServiceTrade company detail error", { error: err.message });
    return res.status(500).json({ error: "Failed to load company detail" });
  }
});

/**
 * GET /integrations/servicetrade/locations/:locationId
 * Location detail with service requests, contacts, assets.
 */
router.get("/locations/:locationId", async (req, res) => {
  const companyId = req.user.companyId;
  const locationId = parseInt(req.params.locationId, 10);

  if (Number.isNaN(locationId)) {
    return res.status(400).json({ error: "Invalid location id" });
  }

  try {
    const location = await syncDb.getLocationById(companyId, locationId);
    if (!location) {
      return res.status(404).json({ error: "Location not found" });
    }
    const [serviceRequests, contacts, assets] = await Promise.all([
      syncDb.listServiceRequestsByLocation(companyId, locationId),
      syncDb.listContactsByLocation(companyId, locationId),
      syncDb.listAssetsByLocation(companyId, locationId),
    ]);
    return res.json({
      location,
      service_requests: serviceRequests,
      contacts,
      assets,
    });
  } catch (err) {
    logger.error("ServiceTrade location detail error", { error: err.message });
    return res.status(500).json({ error: "Failed to load location" });
  }
});

module.exports = router;
