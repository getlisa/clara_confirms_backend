/**
 * Service opportunities routes — reads from the standalone `service_opportunities` table.
 *
 * GET /service-opportunities      — list (filter by location_id, office_id, job_id, status)
 * GET /service-opportunities/:id  — detail with location/job/service-line context + preferred techs
 */

const express = require("express");
const serviceOpportunitiesDb = require("../db/service-opportunities");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

/**
 * GET /service-opportunities
 * Query params: location_id, office_id, job_id, status, service_line_id, city, limit, offset
 */
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { location_id, office_id, job_id, status, service_line_id, city, limit, offset } = req.query;
    const limitNum = limit ? Math.min(Number(limit), 200) : 50;
    const offsetNum = offset ? Number(offset) : 0;

    const { rows: serviceOpportunities, total } = await serviceOpportunitiesDb.list(companyId, {
      locationId:    location_id     ? Number(location_id)     : undefined,
      officeId:      office_id       ? Number(office_id)       : undefined,
      jobId:         job_id          ? Number(job_id)          : undefined,
      status:        status || undefined,
      serviceLineId: service_line_id ? Number(service_line_id) : undefined,
      city:          city || undefined,
      limit:         limitNum,
      offset:        offsetNum,
    });

    return res.json({
      service_opportunities: serviceOpportunities,
      pagination: { total, limit: limitNum, offset: offsetNum, totalPages: Math.max(Math.ceil(total / limitNum), 1) },
    });
  } catch (err) {
    logger.error("GET /service-opportunities failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load service opportunities" });
  }
});

/**
 * GET /service-opportunities/service-lines
 * Distinct service lines for this company, for filter dropdowns.
 * Registered before /:id so "service-lines" isn't swallowed as an :id param.
 */
router.get("/service-lines", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const serviceLines = await serviceOpportunitiesDb.listServiceLines(companyId);
    return res.json({ service_lines: serviceLines });
  } catch (err) {
    logger.error("GET /service-opportunities/service-lines failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load service lines" });
  }
});

/**
 * GET /service-opportunities/:id
 */
router.get("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const opportunity = await serviceOpportunitiesDb.getById(Number(req.params.id), companyId);
    if (!opportunity) return res.status(404).json({ error: "Service opportunity not found" });

    return res.json({ service_opportunity: opportunity });
  } catch (err) {
    logger.error("GET /service-opportunities/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load service opportunity" });
  }
});

module.exports = router;
