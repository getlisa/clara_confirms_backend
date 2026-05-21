const express = require("express");
const callSettingsDb = require("../db/call-settings");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");
const router = express.Router();
router.use(authenticate);

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const settings = await callSettingsDb.getByCompanyId(companyId);
    return res.json({ call_settings: settings });
  } catch (err) {
    logger.error("GET /call-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load call settings" });
  }
});

router.patch("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const { business_hours_start, business_hours_end, max_attempts, voicemail_behavior, include_weekends } = req.body;
    const fields = {};
    if (business_hours_start !== undefined) fields.business_hours_start = business_hours_start;
    if (business_hours_end   !== undefined) fields.business_hours_end   = business_hours_end;
    if (include_weekends     !== undefined) fields.include_weekends     = Boolean(include_weekends);
    if (voicemail_behavior !== undefined) {
      if (!["leave", "skip"].includes(voicemail_behavior))
        return res.status(400).json({ error: "voicemail_behavior must be 'leave' or 'skip'" });
      fields.voicemail_behavior = voicemail_behavior;
    }
    if (max_attempts !== undefined) {
      const val = Number(max_attempts);
      if (!Number.isInteger(val) || val < 1 || val > 10)
        return res.status(400).json({ error: "max_attempts must be an integer between 1 and 10" });
      fields.max_attempts = val;
    }
    if (Object.keys(fields).length === 0)
      return res.status(400).json({ error: "No fields to update" });
    const settings = await callSettingsDb.upsert(companyId, fields);
    return res.json({ call_settings: settings });
  } catch (err) {
    logger.error("PATCH /call-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update call settings" });
  }
});

module.exports = router;
