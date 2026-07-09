/**
 * Campaigns routes (Process 2 — Delivery)
 *
 * A campaign is the single config entity: trigger behavior (when/who) + its own
 * agent (prompt/greeting/voicemail) + provisioned Retell artifacts. Backed by the
 * `campaigns` table (src/db/campaigns.js).
 *
 * Campaign-facing field names → underlying columns:
 *   greeting ↔ begin_message   prompt ↔ general_prompt   voicemail ↔ voicemail_message   config ↔ trigger_config
 *
 * GET   /campaigns          — list the company's campaigns
 * PATCH /campaigns/:key     — update config (enabled, prompt, greeting, voicemail, …)
 */

const express = require("express");
const campaignsDb = require("../db/campaigns");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

function toCampaign(c) {
  return {
    key:         c.key,
    name:        c.name,
    enabled:     c.enabled,
    days_before: c.days_before,
    greeting:    c.begin_message ?? null,      // agent's opening line
    prompt:      c.general_prompt ?? null,      // agent instructions (basis of the agent)
    voicemail:   c.voicemail_message ?? null,   // voicemail template
    config:      c.trigger_config ?? {},        // trigger-specific settings
    description: c.description ?? null,
    updated_at:  c.updated_at ?? null,
  };
}

// Map campaign-facing fields → underlying campaigns columns.
function toColumns(body) {
  const patch = {};
  if (body.enabled     !== undefined) patch.enabled           = body.enabled;
  if (body.days_before !== undefined) patch.days_before       = body.days_before;
  if (body.name        !== undefined) patch.name              = body.name;
  if (body.greeting    !== undefined) patch.begin_message     = body.greeting;
  if (body.prompt      !== undefined) patch.general_prompt    = body.prompt;
  if (body.voicemail   !== undefined) patch.voicemail_message = body.voicemail;
  if (body.config      !== undefined) patch.trigger_config    = body.config;
  return patch;
}

// Fields that change what the live Retell agent says/does → trigger a re-provision.
const AGENT_AFFECTING = ["enabled", "name", "greeting", "prompt"];

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const campaigns = await campaignsDb.getAllByCompanyId(companyId);
    return res.json({ campaigns: campaigns.map(toCampaign) });
  } catch (err) {
    logger.error("GET /campaigns failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load campaigns" });
  }
});

router.patch("/:key", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    if (req.body.days_before !== undefined) {
      const val = Number(req.body.days_before);
      if (!Number.isInteger(val) || val < 1) {
        return res.status(400).json({ error: "days_before must be an integer >= 1" });
      }
    }

    const patch = toColumns(req.body);
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    const campaign = await campaignsDb.upsert(companyId, req.params.key, patch);

    // If the change affects the live agent, re-provision the Retell flow (non-fatal).
    if (AGENT_AFFECTING.some((f) => f in req.body)) {
      try {
        const { syncFlowForCompany } = require("../services/retell-flow");
        await syncFlowForCompany(companyId);
      } catch (err) {
        logger.warn("PATCH /campaigns: Retell re-sync failed (non-fatal)", { companyId, key: req.params.key, error: err.message });
      }
    }

    return res.json({ campaign: toCampaign(campaign) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logger.error("PATCH /campaigns/:key failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update campaign" });
  }
});

module.exports = router;
