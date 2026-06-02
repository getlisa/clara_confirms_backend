const express = require("express");
const agentSettingsDb = require("../db/agent-settings");
const callTypeConfigsDb = require("../db/call-type-configs");
const { authenticate, getCompanyId } = require("../auth");
const { syncFlowForCompany } = require("../services/retell-flow");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

// ── Global agent identity ─────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const row = await agentSettingsDb.getByCompanyId(companyId);
    return res.json({ agent_settings: { representative_name: row.representative_name ?? null } });
  } catch (err) {
    logger.error("GET /agent-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load agent settings" });
  }
});

// Updating representative_name also re-syncs the flow so all subagent prompts
// that reference {{representative_name}} pick up the new value via the flow's
// default_dynamic_variables.
router.patch("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { representative_name } = req.body;
    if (representative_name === undefined) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const saved = await agentSettingsDb.upsert(companyId, { representative_name });

    syncFlowForCompany(companyId).catch((err) =>
      logger.error("Retell flow sync failed after representative_name update", { companyId, error: err.message })
    );

    return res.json({ agent_settings: { representative_name: saved.representative_name ?? null } });
  } catch (err) {
    logger.error("PATCH /agent-settings failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update agent settings" });
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
      return res.status(422).json({ error: "No call types configured — add at least one call type before syncing" });
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

// ── Call type configs ─────────────────────────────────────────────────────────

router.get("/call-types", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const call_types = await callTypeConfigsDb.getAllByCompanyId(companyId);
    return res.json({ call_types });
  } catch (err) {
    logger.error("GET /agent-settings/call-types failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load call type configs" });
  }
});

router.post("/call-types", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { name, description } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ error: "description is required" });
    }
    if (await callTypeConfigsDb.nameExists(companyId, name)) {
      return res.status(409).json({ error: "A call type with this name already exists" });
    }

    const call_type = await callTypeConfigsDb.create(companyId, {
      name: String(name).trim(),
      description: String(description).trim(),
    });

    // New node added to the flow
    syncFlowForCompany(companyId).catch((err) =>
      logger.error("Retell flow sync failed after call-type create", { companyId, type: call_type.type, error: err.message })
    );

    return res.status(201).json({ call_type });
  } catch (err) {
    logger.error("POST /agent-settings/call-types failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create call type" });
  }
});

router.patch("/call-types/:type", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { type } = req.params;
    const { enabled, begin_message, general_prompt, name, description } = req.body;
    const fields = {};

    if (enabled !== undefined) fields.enabled = Boolean(enabled);
    if (begin_message !== undefined) fields.begin_message = begin_message;
    if (general_prompt !== undefined) fields.general_prompt = general_prompt;
    if (name !== undefined) fields.name = String(name).trim();
    if (description !== undefined) fields.description = String(description).trim();

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    if (fields.name && !callTypeConfigsDb.BUILTIN_TYPES.includes(type)) {
      if (await callTypeConfigsDb.nameExists(companyId, fields.name, type)) {
        return res.status(409).json({ error: "A call type with this name already exists" });
      }
    }

    const call_type = await callTypeConfigsDb.upsert(companyId, type, fields);
    if (!call_type) return res.status(404).json({ error: "Call type not found" });

    // Sync flow whenever prompt or structure changes
    const promptChanged = fields.begin_message !== undefined || fields.general_prompt !== undefined;
    const structureChanged = fields.name !== undefined || fields.enabled !== undefined;
    if (promptChanged || structureChanged) {
      syncFlowForCompany(companyId).catch((err) =>
        logger.error("Retell flow sync failed after call-type update", { companyId, type, error: err.message })
      );
    }

    return res.json({ call_type });
  } catch (err) {
    logger.error("PATCH /agent-settings/call-types/:type failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update call type config" });
  }
});

router.delete("/call-types/:type", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    await callTypeConfigsDb.remove(companyId, req.params.type);

    // Node removed from the flow
    syncFlowForCompany(companyId).catch((err) =>
      logger.error("Retell flow sync failed after call-type delete", { companyId, type: req.params.type, error: err.message })
    );

    return res.json({ message: "Deleted" });
  } catch (err) {
    const status = err.status || 500;
    const message = status < 500 ? err.message : "Failed to delete call type";
    logger.error("DELETE /agent-settings/call-types/:type failed", { error: err.message });
    return res.status(status).json({ error: message });
  }
});

module.exports = router;
