/**
 * Syncs call-type prompts from call_type_configs (DB) to the company's
 * Retell conversation flow nodes.
 *
 * Flow ID is fetched from the DB — never hardcoded.
 * Can run for a single company or all active companies.
 */
const db = require("../db");
const retell = require("./retell");
const callTypeConfigsDb = require("../db/call-type-configs");
const logger = require("../utils/logger");
const { CHAT_SESSION_INSTRUCTION } = require("./retell-flow");
const { resolveSlugForCompany } = require("./crm");
const { getWorkflow } = require("../confirmation-agent/workflows");

const serviceLineDescriptionsDb = require("../db/service-line-descriptions");

/**
 * The company's onsite-expectation notes, as a prompt block.
 *
 * These live in the `service_line_descriptions` table and were previously
 * hard-baked into one company's stored voice prompt by hand. That made
 * resetDefaultPrompts destructive: regenerating from code silently dropped
 * them, with no repeatable way to put them back. Building the block here means
 * a reset re-appends whatever the company currently has, so the table stays the
 * single source of truth — the same table the chat agent already reads live
 * (confirmation-agent/graph/build.js).
 *
 * Returns "" when a company has none, so nothing is appended.
 */
async function buildOnsiteExpectationsBlock(companyId) {
  const rows = await serviceLineDescriptionsDb.listByCompany(companyId).catch(() => []);
  if (!rows.length) return "";
  const entries = rows.map((r) => `${r.title}:\n${r.description}`).join("\n\n");
  return [
    "",
    "",
    "━━━ ONSITE EXPECTATIONS — STATE THESE, DON'T WAIT TO BE ASKED ━━━",
    "Every confirmation must tell the customer what to expect onsite: building access, noise, and rough duration. This is the note the site needs in order to prepare — giving tenants notice, unlocking units, expecting the panel to sound. A confirmation that skips it is incomplete, even if the customer never asks.",
    "Pick the ONE entry matching this visit, by reading the appointment's own service_line/job text. If the job covers several services, use the single combined entry (e.g. alarm + sprinkler) rather than reading two. If nothing clearly matches, describe the visit only in general terms — never invent access or noise specifics.",
    "On a call keep it to a sentence or two, in your own words — these are notes to convey, not a script to recite. Don't read the whole list.",
    "",
    entries,
  ].join("\n");
}

/**
 * Reset DB prompts for all built-in call types for a company back to the
 * current defaults from generateDefaultPrompts().
 * Only overwrites is_custom = false rows.
 */
async function resetDefaultPrompts(companyId, types = null) {
  const seeds = callTypeConfigsDb.BUILTIN_SEEDS.filter(
    s => !types || types.includes(s.type)
  );
  const workflow = getWorkflow(await resolveSlugForCompany(companyId));
  let updated = 0;
  for (const seed of seeds) {
    const { begin_message, general_prompt } = callTypeConfigsDb.generateDefaultPrompts(
      seed.type, seed.name, seed.description, workflow
    );
    // Only the confirmation prompt carries onsite expectations, and only for
    // companies that have any. Appending here (rather than at push time) keeps
    // the stored prompt the source of truth, so every path that pushes it —
    // prompt-sync and retell-flow — carries the block without knowing about it.
    const extra = seed.type === "customer_confirmation"
      ? await buildOnsiteExpectationsBlock(companyId)
      : "";

    const result = await db.query(
      `UPDATE call_type_configs
       SET begin_message = $1, general_prompt = $2, updated_at = NOW()
       WHERE company_id = $3 AND type = $4 AND is_custom = false`,
      [begin_message, general_prompt + extra, companyId, seed.type]
    );
    if (result.rowCount > 0) {
      updated++;
      logger.info("resetDefaultPrompts: updated DB", { companyId, type: seed.type });
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
    `SELECT type, begin_message, general_prompt,
            retell_llm_id, retell_subagent_node_id
     FROM call_type_configs
     WHERE company_id = $1
       AND retell_llm_id IS NOT NULL
       AND retell_subagent_node_id IS NOT NULL
       ${types && types.length ? `AND type = ANY($2::text[])` : ""}`,
    types && types.length ? [companyId, types] : [companyId]
  );

  if (rows.length === 0) {
    logger.warn("syncPrompts: no provisioned call types found", { companyId });
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
    // customer_confirmation also carries the chat-session instruction (see
    // retell-flow.js) — rebuilding from general_prompt alone would otherwise
    // silently drop it on every prompt sync.
    const chatInstruction = row.type === "customer_confirmation" ? `\n\n${CHAT_SESSION_INSTRUCTION.trim()}` : "";
    const newText = row.general_prompt + chatInstruction + (readOnlyMatch ? readOnlyMatch[0] : "");

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
 * The marker that proves a company's stored confirmation prompt can actually
 * SPEAK a pre-visit instruction (CMAP-230).
 *
 * The instruction text itself never goes into the prompt — it rides per-call in
 * retell_llm_dynamic_variables, so a newly authored instruction is picked up on
 * the very next call with no Retell write at all. What the prompt must carry is
 * the SCAFFOLDING: the data block that introduces the variables and the STEP
 * that delivers them. Without it the variable is bound and then silently
 * ignored, which is the one failure mode here that looks like nothing is wrong.
 */
const PREVISIT_PROMPT_MARKER = "{{previsit_instructions}}";

/**
 * Make sure this company's agent can speak pre-visit instructions, and repair
 * it if not. Called after an instruction is authored from the platform.
 *
 * Idempotent and cheap in the common case: one indexed read, and no Retell
 * traffic at all once the scaffolding is in place. It only ever does work the
 * FIRST time a company authors an instruction (or after its prompt was reset
 * to a generation older than this feature).
 *
 * NOTE ON SCOPE — worth knowing before reading the logs: repairing the prompt
 * regenerates it wholesale from generateDefaultPrompts, because that is how
 * prompts are built here. For a company sitting on an older generation that
 * also brings every other accumulated prompt change forward, not just this
 * block. That is why it logs at info with `changed: true` rather than quietly.
 *
 * Never throws: the instruction row is already committed by the time this
 * runs, and a Retell outage must not turn a saved setting into a 500.
 */
async function ensurePrevisitPromptCurrent(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT general_prompt, is_custom FROM call_type_configs
        WHERE company_id = $1 AND type = 'customer_confirmation'`,
      [companyId]
    );

    if (!rows.length) {
      // Not provisioned for confirmations at all — nothing to repair, and not
      // an error: the instruction is stored and becomes live if they are.
      return { ok: true, changed: false, reason: "no_confirmation_prompt" };
    }

    const row = rows[0];
    if (String(row.general_prompt || "").includes(PREVISIT_PROMPT_MARKER)) {
      return { ok: true, changed: false, reason: "already_current" };
    }

    if (row.is_custom) {
      // A hand-written prompt belongs to whoever wrote it — resetDefaultPrompts
      // deliberately skips is_custom rows, so overriding that here would throw
      // away their work. Report it instead of silently storing an instruction
      // the agent will never say.
      logger.warn("previsit: company has a custom confirmation prompt — instruction will NOT be spoken until it is added by hand", { companyId });
      return { ok: false, changed: false, reason: "custom_prompt" };
    }

    await resetDefaultPrompts(companyId, ["customer_confirmation"]);
    const { updated } = await syncPromptsForCompany(companyId, ["customer_confirmation"]);
    logger.info("previsit: confirmation prompt brought current and pushed to Retell", { companyId, retellNodesUpdated: updated, changed: true });
    return { ok: true, changed: true, reason: "synced", retell_nodes_updated: updated };
  } catch (err) {
    logger.error("previsit: could not bring the confirmation prompt current", { companyId, error: err.message });
    return { ok: false, changed: false, reason: "error", error: err.message };
  }
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
  ensurePrevisitPromptCurrent,
  PREVISIT_PROMPT_MARKER,
};
