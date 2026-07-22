/**
 * Call Trigger Configuration routes
 *
 * GET  /call-triggers           — list all 3 trigger configs for the company
 * PATCH /call-triggers/:type    — enable/disable or update a trigger
 */

const express = require("express");
const triggerDb = require("../db/call-trigger-configs");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");
const { getCompanyTimezone, localizeFields, localizeRows } = require("../utils/timezone");

const router = express.Router();
router.use(authenticate);

const TRIGGER_TZ_FIELDS = ["created_at", "updated_at"];

/**
 * GET /call-triggers
 * Returns all three trigger configs. Missing rows return defaults.
 */
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const triggers = await triggerDb.getAllByCompanyId(companyId);
    const tz = await getCompanyTimezone(companyId);
    return res.json({ call_triggers: localizeRows(triggers, tz, TRIGGER_TZ_FIELDS) });
  } catch (err) {
    logger.error("GET /call-triggers failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load call triggers" });
  }
});

/**
 * PATCH /call-triggers/:type
 * Update one trigger. :type must be one of the three valid types.
 * Body: { enabled?, call_type?, days_before?, trigger_config? }
 */
router.patch("/:type", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { type } = req.params;

    if (Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // Validate days_before if provided
    if (req.body.days_before !== undefined) {
      const val = Number(req.body.days_before);
      if (!Number.isInteger(val) || val < 1) {
        return res.status(400).json({ error: "days_before must be an integer >= 1" });
      }
    }

    const trigger = await triggerDb.upsert(companyId, type, req.body);
    const tz = await getCompanyTimezone(companyId);
    return res.json({ call_trigger: localizeFields(trigger, tz, TRIGGER_TZ_FIELDS) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logger.error("PATCH /call-triggers/:type failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update call trigger" });
  }
});

module.exports = router;
