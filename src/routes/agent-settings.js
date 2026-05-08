const express = require("express");
const agentSettingsDb = require("../db/agent-settings");
const { authenticate, getCompanyId } = require("../auth");
const retell = require("../services/retell");
const logger = require("../utils/logger");

const router = express.Router();

router.use(authenticate);

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const agent_settings = await agentSettingsDb.getByCompanyId(companyId);
    return res.json({ agent_settings });
  } catch (err) {
    logger.error("GET /agent-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load agent settings" });
  }
});

router.patch("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { representative_name, begin_message, general_prompt, days_before_confirmation } = req.body;
    const fields = {};

    if (representative_name !== undefined) fields.representative_name = representative_name;
    if (begin_message !== undefined) fields.begin_message = begin_message;
    if (general_prompt !== undefined) fields.general_prompt = general_prompt;

    if (days_before_confirmation !== undefined) {
      const val = Number(days_before_confirmation);
      if (!Number.isInteger(val) || val < 1) {
        return res.status(400).json({ error: "days_before_confirmation must be an integer >= 1" });
      }
      fields.days_before_confirmation = val;
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const agent_settings = await agentSettingsDb.upsert(companyId, fields);

    // Sync to Retell in the background — don't block the response
    retell.syncAgentForCompany(companyId, agent_settings).catch((err) =>
      logger.error("Retell agent sync failed after settings update", { companyId, error: err.message })
    );

    return res.json({ agent_settings });
  } catch (err) {
    logger.error("PATCH /agent-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update agent settings" });
  }
});

module.exports = router;
