const express = require("express");
const agentSettingsDb = require("../db/agent-settings");
const { authenticate, getCompanyId } = require("../auth");
const { syncFlowForCompany } = require("../services/retell-flow");
const retell = require("../services/retell");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

// ── Global agent identity ─────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const row = await agentSettingsDb.getByCompanyId(companyId);
    return res.json({
      agent_settings: {
        representative_name: row.representative_name ?? null,
        voice_id:            row.voice_id ?? null,
      },
    });
  } catch (err) {
    logger.error("GET /agent-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load agent settings" });
  }
});

// Updating representative_name or voice_id re-syncs the flow so the Retell
// agent picks up the new value (voice via agent.update, representative_name
// via the flow's default_dynamic_variables).
router.patch("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { representative_name, voice_id } = req.body;
    if (representative_name === undefined && voice_id === undefined) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // Validate voice_id against the live Retell voice catalog before persisting.
    if (voice_id !== undefined && voice_id !== null) {
      const ok = await retell.isVoiceIdValid(voice_id);
      if (!ok) {
        return res.status(400).json({ error: `Unknown voice_id '${voice_id}'. Call GET /agent-settings/voices to see available voices.` });
      }
    }

    const fields = {};
    if (representative_name !== undefined) fields.representative_name = representative_name;
    if (voice_id !== undefined) fields.voice_id = voice_id;
    const saved = await agentSettingsDb.upsert(companyId, fields);

    syncFlowForCompany(companyId).catch((err) =>
      logger.error("Retell flow sync failed after agent_settings update", { companyId, error: err.message })
    );

    return res.json({
      agent_settings: {
        representative_name: saved.representative_name ?? null,
        voice_id:            saved.voice_id ?? null,
      },
    });
  } catch (err) {
    logger.error("PATCH /agent-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update agent settings" });
  }
});

/**
 * GET /agent-settings/voices
 * List voices available to the Retell account. Cached in-process for 5 min.
 * Pass ?refresh=true to bust the cache.
 *
 * Returns the raw VoiceResponse[] from Retell so the FE can render preview
 * audio and group by provider/gender without further hops.
 */
router.get("/voices", async (req, res) => {
  try {
    const refresh = req.query.refresh === "true";
    const voices = await retell.listVoices({ refresh });
    return res.json({ voices });
  } catch (err) {
    logger.error("GET /agent-settings/voices failed", { error: err.message });
    return res.status(502).json({ error: "Failed to fetch voices from Retell" });
  }
});

// ── Flow status + manual sync ─────────────────────────────────────────────────

/**
 * GET /agent-settings/flow-status
 * Returns whether the Retell conversation flow + agent are provisioned for this company.
 */
router.get("/flow-status", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const result = await require("../db").query(
      `SELECT retell_agent_id, retell_conversation_flow_id, retell_phone_number FROM companies WHERE id = $1`,
      [companyId]
    );
    const company = result.rows[0];
    return res.json({
      flow_status: {
        flow_provisioned: !!company?.retell_conversation_flow_id,
        agent_provisioned: !!company?.retell_agent_id,
        phone_number_set:  !!company?.retell_phone_number,
      },
    });
  } catch (err) {
    logger.error("GET /agent-settings/flow-status failed", { error: err.message });
    return res.status(500).json({ error: "Failed to get flow status" });
  }
});

/**
 * POST /agent-settings/sync-flow
 * Manually provision or repair the Retell conversation flow for this company.
 * Safe to call on existing tenants that predate the flow feature.
 */
router.post("/sync-flow", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const result = await syncFlowForCompany(companyId);
    if (!result) {
      return res.status(422).json({ error: "No campaigns enabled — enable at least one campaign before syncing" });
    }
    return res.json({
      message: "Retell conversation flow synced",
      flow_provisioned: !!result.flowId,
      agent_provisioned: !!result.agentId,
      phone_number_set: !!result.phoneNumber,
    });
  } catch (err) {
    logger.error("POST /agent-settings/sync-flow failed", { error: err.message });
    return res.status(500).json({ error: err.message || "Failed to sync flow" });
  }
});

// NOTE: call-type CRUD (`/agent-settings/call-types`) has been removed. Campaigns
// are the single config entity now — manage prompts/greeting/voicemail/enabled via
// `GET/PATCH /campaigns` (src/routes/campaigns.js).

module.exports = router;
