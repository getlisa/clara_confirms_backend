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
const { resolveSlugForCompany } = require("./crm");
const { getWorkflow, withServiceLinkSetting } = require("../confirmation-agent/workflows");
const callSettingsDb = require("../db/call-settings");

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
 * The default prompt this company would get for a call type right now — what
 * "Reset to default" writes, and what the editor diffs against.
 *
 * Built-in types: the code default for the company's CRM workflow, plus (for
 * customer_confirmation) its onsite-expectation notes. Appending those here,
 * rather than at push time, keeps the stored prompt the source of truth, so
 * every path that pushes it carries the block without knowing about it.
 * User-created types: the generic default derived from their name/description.
 * The SERVICE LINK block is never part of it — composeRetellPrompt adds that
 * at push time.
 */
async function buildDefaultPromptForCompany(companyId, type) {
  const seed = callTypeConfigsDb.BUILTIN_SEEDS.find((s) => s.type === type);
  if (!seed) {
    const { rows } = await db.query(
      `SELECT name, description FROM call_type_configs WHERE company_id = $1 AND type = $2`,
      [companyId, type]
    );
    if (!rows[0]) return null;
    return callTypeConfigsDb.generateDefaultPrompts(type, rows[0].name, rows[0].description || "");
  }
  const workflow = getWorkflow(await resolveSlugForCompany(companyId));
  const { begin_message, general_prompt } = callTypeConfigsDb.generateDefaultPrompts(
    seed.type, seed.name, seed.description, workflow
  );
  const extra = type === "customer_confirmation" ? await buildOnsiteExpectationsBlock(companyId) : "";
  return { begin_message, general_prompt: general_prompt + extra };
}

/**
 * Reset DB prompts for all built-in call types for a company back to the
 * current defaults from generateDefaultPrompts().
 * Only overwrites is_custom = false rows, and never a prompt the user edited
 * (prompt_customized) — automatic resets must not erase their work; only the
 * editor's explicit "Reset to default" (routes/agent-settings.js) clears that.
 * Bumps prompt_version so an editor open on the old text gets a 409 on save
 * instead of silently overwriting the regenerated prompt.
 */
async function resetDefaultPrompts(companyId, types = null) {
  const seeds = callTypeConfigsDb.BUILTIN_SEEDS.filter(
    s => !types || types.includes(s.type)
  );
  let updated = 0;
  for (const seed of seeds) {
    const { begin_message, general_prompt } = await buildDefaultPromptForCompany(companyId, seed.type);

    const result = await db.query(
      `UPDATE call_type_configs
       SET begin_message = $1, general_prompt = $2, prompt_version = prompt_version + 1, updated_at = NOW()
       WHERE company_id = $3 AND type = $4 AND is_custom = false AND prompt_customized = false
         AND (general_prompt IS DISTINCT FROM $2 OR begin_message IS DISTINCT FROM $1)`,
      [begin_message, general_prompt, companyId, seed.type]
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
/**
 * Whether this company's confirmation prompt gets the SERVICE LINK block:
 * its CRM must support a service link AND "Email the service link after
 * confirmation" (call_settings.service_link_enabled) must be on.
 */
async function isServiceLinkOn(companyId) {
  const settings = await callSettingsDb.getByCompanyId(companyId);
  const workflow = withServiceLinkSetting(getWorkflow(await resolveSlugForCompany(companyId)), settings?.service_link_enabled);
  return workflow.capabilities.serviceLink === true;
}

/**
 * The exact instruction text a call type's Retell node should carry: the
 * stored (user-editable) general_prompt, then the system-managed blocks.
 *
 *  - SERVICE LINK (customer_confirmation only, when serviceLinkOn) — appended
 *    here rather than stored, so toggling the setting never touches the
 *    user's text. Skipped if the stored prompt already carries the section
 *    itself, so a pasted-in copy never doubles up.
 *  - The read-only note (registerToolsForCompany owns it) is preserved by the
 *    caller from the node's current text, as before.
 *
 * Exported for the prompt editor's "what the agent will actually get" view.
 */
function composeRetellPrompt(type, generalPrompt, { serviceLinkOn = false, readOnlyNote = "" } = {}) {
  let text = generalPrompt || "";
  if (type === "customer_confirmation" && serviceLinkOn && !text.includes(callTypeConfigsDb.SERVICE_LINK_PROMPT_MARKER)) {
    text += `\n\n${callTypeConfigsDb.SERVICE_LINK_SECTION}`;
  }
  return text + (readOnlyNote || "");
}

const READ_ONLY_NOTE_RE = /\n\n\[IMPORTANT: You are in read-only mode[\s\S]*?\]/;

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
  const serviceLinkOn = rows.some((r) => r.type === "customer_confirmation") ? await isServiceLinkOn(companyId) : false;

  let flow;
  try {
    flow = await client.conversationFlow.retrieve(flowId);
  } catch (err) {
    await Promise.all(rows.map((r) => callTypeConfigsDb.markRetellSync(companyId, r.type, { ok: false, error: err.message }).catch(() => {})));
    throw err;
  }
  const nodes = flow.nodes ?? [];

  let updated = 0;
  const pushed = [];
  for (const row of rows) {
    const nodeIdx = nodes.findIndex(n => n.id === row.retell_subagent_node_id);
    if (nodeIdx === -1) {
      logger.warn("syncPrompts: node not found in flow", { nodeId: row.retell_subagent_node_id, type: row.type });
      continue;
    }

    const current = nodes[nodeIdx].instruction?.text || "";
    pushed.push(row.type);
    // Preserve any read-only mode note appended by registerToolsForCompany
    const readOnlyMatch = current.match(READ_ONLY_NOTE_RE);
    const newText = composeRetellPrompt(row.type, row.general_prompt, {
      serviceLinkOn,
      readOnlyNote: readOnlyMatch ? readOnlyMatch[0] : "",
    });

    if (newText === current) {
      logger.info("syncPrompts: no change", { type: row.type });
      continue;
    }

    nodes[nodeIdx] = { ...nodes[nodeIdx], instruction: { type: "prompt", text: newText } };
    updated++;
    logger.info("syncPrompts: updated node", { type: row.type, nodeId: row.retell_subagent_node_id });
  }

  if (updated > 0) {
    try {
      await client.conversationFlow.update(flowId, { nodes });
    } catch (err) {
      await Promise.all(pushed.map((t) => callTypeConfigsDb.markRetellSync(companyId, t, { ok: false, error: err.message }).catch(() => {})));
      throw err;
    }
    logger.info("syncPrompts: flow saved", { companyId, flowId, updated });
  }
  // Retell now holds exactly what is stored (changed or already identical).
  await Promise.all(pushed.map((t) => callTypeConfigsDb.markRetellSync(companyId, t, { ok: true }).catch(() => {})));

  return { updated, synced_types: pushed };
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
      `SELECT general_prompt, is_custom, prompt_customized FROM call_type_configs
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

    if (row.is_custom || row.prompt_customized) {
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
 * Push the confirmation prompt to Retell so its SERVICE LINK block matches the
 * company's "Email the service link after confirmation" setting right now.
 * Called after call_settings.service_link_enabled is written — see
 * retell-tools.js's maybeResyncToolsAfterSettingsChange, which awaits this
 * BEFORE re-registering tools so the two flow updates never race.
 *
 * The block is composed at push time (composeRetellPrompt), so this never
 * regenerates or rewrites the stored prompt — an edited prompt keeps every
 * word, and gains or loses only the managed block. Idempotent: no Retell
 * write when the node already matches. Never throws.
 */
async function ensureServiceLinkPromptCurrent(companyId) {
  try {
    const { updated, synced_types: synced = [] } = await syncPromptsForCompany(companyId, ["customer_confirmation"]);
    if (!synced.length) return { ok: true, changed: false, reason: "not_provisioned" };
    logger.info("service-link: confirmation prompt pushed to Retell", { companyId, changed: updated > 0 });
    return { ok: true, changed: updated > 0, reason: updated > 0 ? "synced" : "already_current" };
  } catch (err) {
    logger.error("service-link: could not push the confirmation prompt to Retell", { companyId, error: err.message });
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
  ensureServiceLinkPromptCurrent,
  composeRetellPrompt,
  buildDefaultPromptForCompany,
  isServiceLinkOn,
  PREVISIT_PROMPT_MARKER,
};
