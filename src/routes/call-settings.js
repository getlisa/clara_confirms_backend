const express = require("express");
const callSettingsDb = require("../db/call-settings");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");
const db = require("../db");
const retell = require("../services/retell");

const router = express.Router();
router.use(authenticate);

/**
 * Push voicemail_message to the company's Retell agent after call settings change.
 * Resolves {{representative_name}} and {{company_name}} placeholders with real values.
 * - voicemail_behavior = 'leave' → set the resolved message on the agent
 * - voicemail_behavior = 'skip'  → set empty string (Retell detects voicemail, hangs up silently)
 */
async function syncVoicemailToRetell(companyId, settings) {
  try {
    const { rows } = await db.query(
      `SELECT c.retell_agent_id, c.name AS company_name, a.representative_name
       FROM companies c
       LEFT JOIN agent_settings a ON a.company_id = c.id
       WHERE c.id = $1`,
      [companyId]
    );
    const row = rows[0];
    if (!row?.retell_agent_id) return;

    let message = "";
    if (settings.voicemail_behavior === "leave") {
      const template = settings.voicemail_message || callSettingsDb.DEFAULTS.voicemail_message;
      message = template
        .replace(/\{\{representative_name\}\}/g, row.representative_name || "Clara")
        .replace(/\{\{company_name\}\}/g, row.company_name || "our company");
    }
    // empty string = detect voicemail but hang up without speaking

    const client = retell.getClient();
    await client.agent.update(row.retell_agent_id, { voicemail_message: message });
    logger.info("Voicemail message synced to Retell", { companyId, behavior: settings.voicemail_behavior });
  } catch (err) {
    logger.warn("syncVoicemailToRetell: failed (non-fatal)", { companyId, error: err.message });
  }
}

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
    const { business_hours_start, business_hours_end, max_attempts, voicemail_behavior, voicemail_message, include_weekends, alert_days_before, agent_can_make_changes } = req.body;
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
    if (alert_days_before !== undefined) {
      const val = Number(alert_days_before);
      if (!Number.isInteger(val) || val < 1)
        return res.status(400).json({ error: "alert_days_before must be an integer >= 1" });
      fields.alert_days_before = val;
    }
    if (voicemail_message !== undefined) {
      if (typeof voicemail_message !== "string")
        return res.status(400).json({ error: "voicemail_message must be a string" });
      fields.voicemail_message = voicemail_message;
    }
    if (agent_can_make_changes !== undefined) {
      if (typeof agent_can_make_changes !== "boolean")
        return res.status(400).json({ error: "agent_can_make_changes must be a boolean" });
      fields.agent_can_make_changes = agent_can_make_changes;
    }
    if (Object.keys(fields).length === 0)
      return res.status(400).json({ error: "No fields to update" });
    const settings = await callSettingsDb.upsert(companyId, fields);

    // Sync voicemail message to Retell whenever voicemail-related fields change
    const voicemailFields = ["voicemail_behavior", "voicemail_message"];
    if (voicemailFields.some(f => fields[f] !== undefined)) {
      syncVoicemailToRetell(companyId, settings).catch(() => {});
    }

    // Re-register Retell tools when agent_can_make_changes changes (adds/removes write tools)
    if (fields.agent_can_make_changes !== undefined) {
      const { registerToolsForCompany } = require("../services/retell-tools");
      registerToolsForCompany(companyId).catch((err) => {
        logger.warn("Tool re-registration failed after agent_can_make_changes update", { error: err.message });
      });
    }

    return res.json({ call_settings: settings });
  } catch (err) {
    logger.error("PATCH /call-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update call settings" });
  }
});

module.exports = router;
