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
const { getCompanyTimezone, localizeRows, localizeFields } = require("../utils/timezone");

const router = express.Router();
router.use(authenticate);

const LOCATION_TZ_FIELDS = ["created_at", "updated_at"];

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

    const tz = await getCompanyTimezone(companyId);
    return res.json({
      locations: localizeRows(locations, tz, LOCATION_TZ_FIELDS),
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

    const locationId = Number(req.params.id);
    const location = await locationsDb.getById(locationId, companyId);
    if (!location) return res.status(404).json({ error: "Location not found" });

    // The full list on DETAIL only; the paged list endpoint carries counts.
    // A site can have 29 open items and an unbounded array in every page of
    // GET /locations would grow the payload without limit.
    const { rows: deficiencies, total: openTotal } =
      await locationsDb.listDeficiencies(companyId, locationId, { openOnly: true, limit: 200 });

    const tz = await getCompanyTimezone(companyId);
    return res.json({
      location: {
        ...localizeFields(location, tz, LOCATION_TZ_FIELDS),
        deficiency_summary: { open: openTotal, by_status: countByStatus(deficiencies) },
        deficiencies,
      },
    });
  } catch (err) {
    logger.error("GET /locations/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load location" });
  }
});

/**
 * GET /locations/:id/deficiencies
 * Query: is_resolved (true|false, default false), status, limit, offset
 *
 * Its own endpoint so a UI panel can page and filter without re-fetching the
 * whole location, and so "show resolved too" is possible — the location detail
 * deliberately returns open ones only.
 */
router.get("/:id/deficiencies", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const location = await locationsDb.getById(Number(req.params.id), companyId);
    if (!location) return res.status(404).json({ error: "Location not found" });

    const { is_resolved, status, limit, offset } = req.query;
    const limitNum = limit ? Math.min(Number(limit), 200) : 100;
    const offsetNum = offset ? Number(offset) : 0;

    const { rows, total } = await locationsDb.listDeficiencies(companyId, Number(req.params.id), {
      // Default: outstanding only. `is_resolved=true` asks for the history.
      openOnly: is_resolved !== "true",
      status: status || null,
      limit: limitNum,
      offset: offsetNum,
    });

    return res.json({
      deficiencies: rows,
      pagination: { total, limit: limitNum, offset: offsetNum, totalPages: Math.max(Math.ceil(total / limitNum), 1) },
    });
  } catch (err) {
    logger.error("GET /locations/:id/deficiencies failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load deficiencies" });
  }
});

/** Status is null on ~99% of InspectPoint rows; bucket those as "unspecified". */
function countByStatus(rows) {
  const out = {};
  for (const r of rows) {
    const k = r.status || "unspecified";
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

module.exports = router;
