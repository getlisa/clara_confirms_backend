/**
 * Campaigns routes (Process 2 — Delivery)
 *
 * Campaigns are the company's configurable outreach playbooks. v1 exposes a
 * per-campaign on/off toggle. Each campaign maps to an underlying call trigger
 * (call_trigger_configs); the campaign's `call_type` selects which Retell
 * sub-agent handles the interaction.
 *
 * GET   /campaigns          — list the company's campaigns (with enabled flag)
 * PATCH /campaigns/:key     — toggle on/off (and optionally tweak config)
 */

const express = require("express");
const triggerDb = require("../db/call-trigger-configs");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

function toCampaign(t) {
  return {
    key:         t.trigger_type,
    name:        t.description ?? t.trigger_type,
    enabled:     t.enabled,
    call_type:   t.call_type,
    days_before: t.days_before,
    config:      t.trigger_config ?? {},
    updated_at:  t.updated_at ?? null,
  };
}

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const triggers = await triggerDb.getAllByCompanyId(companyId);
    return res.json({ campaigns: triggers.map(toCampaign) });
  } catch (err) {
    logger.error("GET /campaigns failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load campaigns" });
  }
});

router.patch("/:key", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    if (Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }
    if (req.body.days_before !== undefined) {
      const val = Number(req.body.days_before);
      if (!Number.isInteger(val) || val < 1) {
        return res.status(400).json({ error: "days_before must be an integer >= 1" });
      }
    }

    const trigger = await triggerDb.upsert(companyId, req.params.key, req.body);
    return res.json({ campaign: toCampaign(trigger) });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    logger.error("PATCH /campaigns/:key failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update campaign" });
  }
});

module.exports = router;
