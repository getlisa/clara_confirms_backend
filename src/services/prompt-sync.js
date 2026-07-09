/**
 * Syncs call-type prompts from call_type_configs (DB) to the company's
 * Retell conversation flow nodes.
 *
 * Flow ID is fetched from the DB — never hardcoded.
 * Can run for a single company or all active companies.
 */
const db = require("../db");
const retell = require("./retell");
const campaignsDb = require("../db/campaigns");
const logger = require("../utils/logger");

/**
 * Reset DB prompts for all built-in call types for a company back to the
 * current defaults from generateDefaultPrompts().
 * Only overwrites is_custom = false rows.
 */
async function resetDefaultPrompts(companyId, types = null) {
  const seeds = campaignsDb.BUILTIN_SEEDS.filter(
    s => !types || types.includes(s.key)
  );
  let updated = 0;
  for (const seed of seeds) {
    const { begin_message, general_prompt } = campaignsDb.generateDefaultPrompts(
      seed.prompt_basis, seed.name, seed.description
    );
    const result = await db.query(
      `UPDATE campaigns
       SET begin_message = $1, general_prompt = $2, updated_at = NOW()
       WHERE company_id = $3 AND trigger_type = $4`,
      [begin_message, general_prompt, companyId, seed.key]
    );
    if (result.rowCount > 0) {
      updated++;
      logger.info("resetDefaultPrompts: updated DB", { companyId, campaign: seed.key });
    }
  }
  return { updated };
}

/**
 * Reset DB prompts for ALL active companies.
 */
async function resetDefaultPromptsForAllCompanies(types = null) {
  const { rows } = await db.query(
    `SELECT id FROM companies WHERE is_active = true OR is_active IS NULL`
  );
  let total = 0;
  for (const co of rows) {
    const { updated } = await resetDefaultPrompts(co.id, types);
    total += updated;
  }
  logger.info("resetDefaultPrompts: all companies done", { total });
  return { total };
}

/**
 * Push the current general_prompt for each call type to the matching
 * subagent node in the company's Retell conversation flow.
 * Also preserves any read-only mode note appended by registerToolsForCompany.
 *
 * @param {number} companyId
 * @param {string[]} [types]  — limit to specific call types (default: all)
 */
async function syncPromptsForCompany(companyId, types = null) {
  // Fetch call type configs with Retell node IDs
  const { rows } = await db.query(
    `SELECT trigger_type AS type, begin_message, general_prompt,
            retell_llm_id, retell_subagent_node_id
     FROM campaigns
     WHERE company_id = $1
       AND retell_llm_id IS NOT NULL
       AND retell_subagent_node_id IS NOT NULL
       ${types && types.length ? `AND trigger_type = ANY($2::text[])` : ""}`,
    types && types.length ? [companyId, types] : [companyId]
  );

  if (rows.length === 0) {
    logger.warn("syncPrompts: no provisioned campaigns found", { companyId });
    return { updated: 0 };
  }

  const flowId = rows[0].retell_llm_id;
  const client = retell.getClient();
  const flow = await client.conversationFlow.retrieve(flowId);
  const nodes = flow.nodes ?? [];

  let updated = 0;
  for (const row of rows) {
    const nodeIdx = nodes.findIndex(n => n.id === row.retell_subagent_node_id);
    if (nodeIdx === -1) {
      logger.warn("syncPrompts: node not found in flow", { nodeId: row.retell_subagent_node_id, type: row.type });
      continue;
    }

    const current = nodes[nodeIdx].instruction?.text || "";
    // Preserve any read-only mode note appended by registerToolsForCompany
    const readOnlyMatch = current.match(/\n\n\[IMPORTANT: You are in read-only mode[\s\S]*?\]/);
    const newText = row.general_prompt + (readOnlyMatch ? readOnlyMatch[0] : "");

    if (newText === current) {
      logger.info("syncPrompts: no change", { type: row.type });
      continue;
    }

    nodes[nodeIdx] = { ...nodes[nodeIdx], instruction: { type: "prompt", text: newText } };
    updated++;
    logger.info("syncPrompts: updated node", { type: row.type, nodeId: row.retell_subagent_node_id });
  }

  if (updated > 0) {
    await client.conversationFlow.update(flowId, { nodes });
    logger.info("syncPrompts: flow saved", { companyId, flowId, updated });
  }

  return { updated };
}

/**
 * Run for all active companies.
 */
async function syncPromptsForAllCompanies(types = null) {
  const { rows: companies } = await db.query(
    `SELECT id FROM companies WHERE is_active = true OR is_active IS NULL`
  );
  let total = 0;
  for (const co of companies) {
    try {
      const { updated } = await syncPromptsForCompany(co.id, types);
      total += updated;
    } catch (err) {
      logger.error("syncPrompts: company failed", { companyId: co.id, error: err.message });
    }
  }
  return { total };
}

module.exports = {
  resetDefaultPrompts,
  resetDefaultPromptsForAllCompanies,
  syncPromptsForCompany,
  syncPromptsForAllCompanies,
};
