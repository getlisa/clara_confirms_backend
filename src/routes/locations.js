/**
 * Locations routes — reads from the standalone `locations` table.
 *
 * GET /locations      — list locations
 * GET /locations/:id  — location detail with primary contact, offices, tags
 */

const express = require("express");
const locationsDb = require("../db/locations");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

/**
 * GET /locations
 * Query params: search, customer_id, is_active (true/false), limit, offset
 */
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { search, customer_id, is_active, limit, offset } = req.query;
    const limitNum = limit ? Math.min(Number(limit), 200) : 50;
    const offsetNum = offset ? Number(offset) : 0;

    const { rows: locations, total } = await locationsDb.list(companyId, {
      search:     search || undefined,
      customerId: customer_id ? Number(customer_id) : undefined,
      isActive:   is_active === "true" ? true : is_active === "false" ? false : undefined,
      limit:      limitNum,
      offset:     offsetNum,
    });

    return res.json({
      locations,
      pagination: { total, limit: limitNum, offset: offsetNum, totalPages: Math.max(Math.ceil(total / limitNum), 1) },
    });
  } catch (err) {
    logger.error("GET /locations failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load locations" });
  }
});

/**
 * GET /locations/:id
 * Returns location + resolved primary_contact, offices[], tags[].
 */
router.get("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const location = await locationsDb.getById(Number(req.params.id), companyId);
    if (!location) return res.status(404).json({ error: "Location not found" });

    return res.json({ location });
  } catch (err) {
    logger.error("GET /locations/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load location" });
  }
});

module.exports = router;
