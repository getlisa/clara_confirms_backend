/**
 * Retell custom tool registration.
 *
 * Tool definitions are stored in the `tool_definitions` DB table (single source
 * of truth). This service reads them, builds Retell-compatible objects, and
 * pushes them to each company's conversation flow nodes.
 *
 * - is_write_tool = false  → always registered (read-only: get_job, get_quotation…)
 * - is_write_tool = true   → only registered when agent_can_make_changes = true
 * - gated_by_setting = '<call_settings column>' → only registered when that
 *   company's call_settings column is true (e.g. search_contact/create_contact
 *   require service_link_enabled). Combines with the is_write_tool gate — both
 *   must pass. `maybeResyncToolsAfterSettingsChange` below re-registers tools
 *   whenever a gating setting changes, so the two-way sync (setting ↔ tools) is
 *   always run through it rather than the caller remembering to call
 *   registerToolsForCompany itself.
 */
const retell = require("./retell");
const db = require("../db");
const callSettingsDb = require("../db/call-settings");
const toolDefsDb = require("../db/tool-definitions");
const logger = require("../utils/logger");

function getBaseUrl() {
  const config = require("../config");
  const webhookUrl = config.retell.webhookUrl || "";
  return webhookUrl.replace(/\/retell\/webhook\/?$/, "").replace(/\/$/, "");
}

/**
 * Convert a DB tool_definitions row into a Retell-compatible custom tool object.
 * Injects company_id as a query param so the webhook knows the tenant.
 */
function dbRowToRetellTool(row, baseUrl, companyId) {
  const secret = process.env.RETELL_TOOL_SECRET || "";
  const headers = secret ? { x_tool_secret: secret } : {};
  const suffix = companyId ? `?company_id=${companyId}` : "";

  const tool = {
    type: "custom",
    name: row.name,
    description: row.description,
    url: `${baseUrl}${row.endpoint}${suffix}`,
    method: row.method || "POST",
    speak_during_execution: row.speak_during_execution,
    speak_after_execution: row.speak_after_execution,
    headers,
  };

  if (row.execution_message_description) {
    tool.execution_message_description = row.execution_message_description;
  }
  if (row.parameters) {
    tool.parameters = typeof row.parameters === "string"
      ? JSON.parse(row.parameters)
      : row.parameters;
  }

  return tool;
}

/**
 * Push tools from tool_definitions DB → each subagent node in the company's
 * conversation flow. Respects agent_can_make_changes: when false, write tools
 * are omitted and the node prompt is annotated with a read-only notice.
 */
async function registerToolsForCompany(companyId) {
  const baseUrl = getBaseUrl();
  if (!baseUrl) {
    logger.warn("registerToolsForCompany: RETELL_WEBHOOK_URL not set — skipping");
    return;
  }

  // Fetch agent_can_make_changes for this company
  const settings = await callSettingsDb.getByCompanyId(companyId);
  const canMakeChanges = settings.agent_can_make_changes !== false;

  // Fetch subagent node IDs per call type
  const { rows: callTypeRows } = await db.query(
    `SELECT type, retell_llm_id, retell_subagent_node_id
     FROM call_type_configs
     WHERE company_id = $1
       AND retell_llm_id IS NOT NULL
       AND retell_subagent_node_id IS NOT NULL`,
    [companyId]
  );

  if (callTypeRows.length === 0) {
    logger.warn("registerToolsForCompany: no provisioned subagent nodes found", { companyId });
    return;
  }

  // Load all enabled tools from DB, filtered by write permission, then by any
  // additional feature-flag gate (e.g. search_contact/create_contact require
  // service_link_enabled — no point offering contact search/creation when the
  // company has that feature off). `settings` is already loaded above.
  const allToolRows = (await toolDefsDb.getAll({ writeToolsEnabled: canMakeChanges }))
    .filter((t) => !t.gated_by_setting || settings[t.gated_by_setting] === true);

  // Split into universal vs per-call-type. Universal tools (call_type='_universal')
  // attach to every subagent node regardless of the company's call types — used
  // for cross-cutting capabilities like schedule_callback that any agent might need.
  const universalTools = [];
  const toolsByCallType = {};
  for (const t of allToolRows) {
    const built = dbRowToRetellTool(t, baseUrl, companyId);
    if (t.call_type === "_universal") {
      universalTools.push(built);
      continue;
    }
    if (!toolsByCallType[t.call_type]) toolsByCallType[t.call_type] = [];
    toolsByCallType[t.call_type].push(built);
  }

  const flowId = callTypeRows[0].retell_llm_id;
  const client = retell.getClient();
  const flow = await client.conversationFlow.retrieve(flowId);
  const nodes = flow.nodes ?? [];

  const changeNote = canMakeChanges
    ? ""
    : "\n\n[IMPORTANT: You are in read-only mode. Do NOT confirm, reschedule, or create appointments. " +
      "Collect the customer's intent and preferences, let them know a team member will follow up, then end the call politely.]";

  let updated = 0;
  for (const row of callTypeRows) {
    const perTypeTools = toolsByCallType[row.type] || [];
    // Universal tools always appended. Sort_order=99 on universal tools keeps
    // them at the end of the agent's tool list (lower-precedence visually).
    const tools = [...perTypeTools, ...universalTools];
    if (tools.length === 0) continue;

    const nodeIdx = nodes.findIndex(n => n.id === row.retell_subagent_node_id);
    if (nodeIdx === -1) {
      logger.warn("registerToolsForCompany: node not found", { nodeId: row.retell_subagent_node_id });
      continue;
    }

    const currentText = nodes[nodeIdx].instruction?.text || "";
    const cleanedText = currentText.replace(/\n\n\[IMPORTANT: You are in read-only mode[\s\S]*?\]/, "");
    const newText = cleanedText + changeNote;

    nodes[nodeIdx] = {
      ...nodes[nodeIdx],
      tools,
      instruction: { ...nodes[nodeIdx].instruction, text: newText },
    };
    updated++;
    logger.info("registerToolsForCompany: node patched", {
      type: row.type,
      nodeId: row.retell_subagent_node_id,
      toolCount: tools.length,
      perTypeCount: perTypeTools.length,
      universalCount: universalTools.length,
      canMakeChanges,
    });
  }

  if (updated > 0) {
    await client.conversationFlow.update(flowId, { nodes });
    logger.info("registerToolsForCompany: flow updated", { companyId, flowId, nodesPatched: updated });
  }

  return { updated };
}

/**
 * Register tools for ALL active companies.
 */
async function registerToolsForAllCompanies() {
  const { rows } = await db.query(
    `SELECT id FROM companies WHERE is_active = true OR is_active IS NULL`
  );
  let total = 0;
  for (const co of rows) {
    try {
      const r = await registerToolsForCompany(co.id);
      total += r?.updated ?? 0;
    } catch (err) {
      logger.error("registerToolsForAllCompanies: company failed", { companyId: co.id, error: err.message });
    }
  }
  logger.info("registerToolsForAllCompanies: done", { total });
  return { total };
}

// call_settings columns that affect which tools get attached to the agent —
// changing any of these must re-register tools. Kept as one list so every
// caller that updates call_settings (REST route, copilot tool, future ones)
// can trigger the same re-registration by calling the helper below instead of
// each re-implementing its own "did a tool-relevant field change" check.
const TOOL_AFFECTING_SETTINGS = ["agent_can_make_changes", "service_link_enabled"];

/**
 * Re-register a company's Retell tools if any changed field affects tool
 * attachment (agent_can_make_changes, or a gated_by_setting column like
 * service_link_enabled). Best-effort — logs and swallows errors, since a
 * failed re-registration should never fail the settings update itself.
 *
 * @param {number|string} companyId
 * @param {string[]} changedFieldNames — keys actually written by the update
 */
async function maybeResyncToolsAfterSettingsChange(companyId, changedFieldNames = []) {
  const affected = changedFieldNames.some((f) => TOOL_AFFECTING_SETTINGS.includes(f));
  if (!affected) return;
  try {
    await registerToolsForCompany(companyId);
  } catch (err) {
    logger.warn("maybeResyncToolsAfterSettingsChange: re-registration failed", { companyId, error: err.message });
  }
}

module.exports = {
  registerToolsForCompany,
  registerToolsForAllCompanies,
  maybeResyncToolsAfterSettingsChange,
  TOOL_AFFECTING_SETTINGS,
  getBaseUrl,
};
