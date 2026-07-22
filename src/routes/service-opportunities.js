/**
 * Service opportunities routes — reads from the standalone `service_opportunities` table.
 *
 * GET /service-opportunities      — list (filter by location_id, office_id, job_id, status)
 * GET /service-opportunities/:id  — detail with location/job/service-line context + preferred techs
 */

const express = require("express");
const serviceOpportunitiesDb = require("../db/service-opportunities");
const scheduledCallsDb = require("../db/scheduled-calls");
const callSettingsDb = require("../db/call-settings");
const todosDb = require("../db/todos");
const scheduler = require("../services/scheduler");
const db = require("../db");
const { toE164 } = require("../utils/phone");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");
const { getCompanyTimezone, localizeRows, localizeFields } = require("../utils/timezone");

const isDev = process.env.NODE_ENV === "development";
const SERVICE_OPPORTUNITY_CALL_TYPE = "service_opportunity_followup";

const router = express.Router();
router.use(authenticate);

const OPPORTUNITY_TZ_FIELDS = ["window_start", "window_end", "closed_on", "created_at", "updated_at"];

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

    const tz = await getCompanyTimezone(companyId);
    return res.json({
      service_opportunities: localizeRows(serviceOpportunities, tz, OPPORTUNITY_TZ_FIELDS),
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
 * POST /service-opportunities/schedule-calls
 * Body: { service_opportunity_ids: number[], immediate?: boolean }
 *
 * Groups the selected opportunities by (location, customer, primary contact,
 * exact window) and schedules ONE outbound "Service Opportunity Follow Up"
 * call per group, dialing the customer. Two+ opportunities sharing all four
 * group by into a single call carrying all their contexts.
 */
router.post("/schedule-calls", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const ids = Array.isArray(req.body?.service_opportunity_ids)
      ? req.body.service_opportunity_ids.map(Number).filter((n) => Number.isInteger(n))
      : [];
    const immediate = req.body?.immediate === true;
    if (ids.length === 0) {
      return res.status(400).json({ error: "service_opportunity_ids (non-empty array) is required" });
    }

    const rows = await serviceOpportunitiesDb.listByIdsForScheduling(companyId, ids);
    if (rows.length === 0) {
      return res.status(404).json({ error: "No matching service opportunities found for this company" });
    }

    const callSettings = await callSettingsDb.getByCompanyId(companyId);
    const { rows: co } = await db.query(`SELECT default_timezone FROM companies WHERE id = $1`, [companyId]);
    const tz = co[0]?.default_timezone || "America/New_York";

    // ── Group by location + customer + primary contact + exact window ──────────
    const groups = new Map();
    for (const r of rows) {
      const key = [
        r.location_id, r.customer_id, r.primary_contact_id,
        r.window_start ? new Date(r.window_start).toISOString() : "null",
        r.window_end ? new Date(r.window_end).toISOString() : "null",
      ].join("|");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const results = [];
    for (const groupRows of groups.values()) {
      const first = groupRows[0];
      const soIds = groupRows.map((r) => r.id).sort((a, b) => a - b);
      const syntheticJobId = `service_opportunity:${soIds.join("-")}`;
      const locationAddress = [first.location_address_line1, first.location_city, first.location_state, first.location_zipcode]
        .filter(Boolean).join(", ") || null;

      // Dial the customer (raw ServiceTrade phone → E.164).
      const phone = toE164(first.customer_phone);
      if (!phone) {
        await todosDb.createMissingPhone({
          companyId,
          jobId: syntheticJobId,
          subjectKind: "service_opportunity",
          subjectName: first.customer_name || first.location_name || null,
          callType: SERVICE_OPPORTUNITY_CALL_TYPE,
          reason: "No usable customer phone number to dial for these service opportunities.",
          metadata: { service_opportunity_ids: soIds, location_id: first.location_id },
          isTest: isDev,
        });
        results.push({ service_opportunity_ids: soIds, status: "skipped_missing_phone" });
        continue;
      }

      // Dedupe: same group already has an active (pending/in_progress) call.
      if (await scheduledCallsDb.existsForJob(companyId, syntheticJobId, SERVICE_OPPORTUNITY_CALL_TYPE, isDev)) {
        results.push({ service_opportunity_ids: soIds, status: "duplicate" });
        continue;
      }

      const primaryContactName = [first.primary_contact_first_name, first.primary_contact_last_name]
        .filter(Boolean).join(" ") || "";
      // Light context for the opening/routing only. The detailed per-opportunity
      // list is fetched by the agent at call time via the get_service_opportunities
      // tool (resolved from this call's synthetic job_id), not passed as a variable.
      const callContext = {
        service_opportunity_count: String(groupRows.length),
        location_name: first.location_name || "your location",
        location_address: locationAddress || "",
        primary_contact_name: primaryContactName,
        general_manager_name: first.general_manager_name || "",
      };

      const fireAt = immediate
        ? new Date()
        : (scheduler.isWithinActiveHours(callSettings, tz, new Date())
            ? new Date()
            : scheduler.getNextWindowStart(callSettings, tz, new Date()));

      try {
        const scheduledCall = await scheduledCallsDb.create({
          companyId,
          callType: SERVICE_OPPORTUNITY_CALL_TYPE,
          phoneNumber: phone,
          jobId: syntheticJobId,
          customerName: first.customer_name || null,
          callContext,
          scheduledAt: fireAt,
          isTest: isDev,
          maxAttempts: callSettings.max_attempts ?? 3,
          callPriority: "high",
          bypassOfficeHours: immediate,
        });
        results.push({ service_opportunity_ids: soIds, status: "scheduled", scheduled_call_id: scheduledCall.id });
      } catch (err) {
        if (err.code === "DUPLICATE_SCHEDULED_CALL" || err.code === "23505") {
          results.push({ service_opportunity_ids: soIds, status: "duplicate" });
        } else {
          throw err;
        }
      }
    }

    // Best-effort immediate dispatch when requested (mirrors manual-call).
    if (immediate && results.some((r) => r.status === "scheduled")) {
      try {
        await scheduler.runDispatcher(results.filter((r) => r.status === "scheduled").length, { companyId, respectAutoFlag: false });
      } catch (err) {
        logger.warn("schedule-calls: dispatcher poke failed; rows remain pending", { error: err.message });
      }
    }

    const summary = {
      groups: results.length,
      scheduled: results.filter((r) => r.status === "scheduled").length,
      skipped_missing_phone: results.filter((r) => r.status === "skipped_missing_phone").length,
      duplicate: results.filter((r) => r.status === "duplicate").length,
    };
    logger.info("schedule-calls: done", { companyId, immediate, summary });
    return res.status(201).json({ summary, results });
  } catch (err) {
    logger.error("POST /service-opportunities/schedule-calls failed", { error: err.message });
    return res.status(500).json({ error: "Failed to schedule service opportunity calls" });
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

    const tz = await getCompanyTimezone(companyId);
    return res.json({ service_opportunity: localizeFields(opportunity, tz, OPPORTUNITY_TZ_FIELDS) });
  } catch (err) {
    logger.error("GET /service-opportunities/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load service opportunity" });
  }
});

module.exports = router;
