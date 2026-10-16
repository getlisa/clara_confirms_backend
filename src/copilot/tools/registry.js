/**
 * Copilot tool registry — the JS source of truth for tool behaviour.
 *
 * Each handler module exports { name, description, isWrite, schema (zod), run }.
 * Adding a capability ("node") = drop a handler file in handlers/{read,write}/
 * and add it to HANDLERS here (+ run the seeder). No graph or loop changes.
 *
 * `build()` turns the enabled handlers into LangChain tools. Whether a tool is
 * *enabled* is governed by the copilot_tool_definitions table; whether a *write*
 * tool is offered on a given turn is governed per-request by the agent node
 * (agent_can_make_changes) — not here.
 */

const { tool } = require("@langchain/core/tools");
const toolDefsDb = require("../../db/copilot-tool-definitions");
const logger = require("../../utils/logger");
const db = require("../../db");
const { PERMISSIONS: PERM, hasPermission, permissionForCallType } = require("../../auth/permissions");

// What each WRITE tool requires (src/auth/permissions.js). The copilot calls
// services directly, not the HTTP routes, so without this a Confirmer could do
// through the copilot what the API refuses them. Read tools need data.read,
// which every role has. make_call / schedule_call depend on the call type the
// trigger resolves to: a confirmation call needs only confirmations.send.
const TOOL_PERMISSIONS = {
  set_todo_status:          PERM.TODOS_MANAGE,
  update_agent_config:      PERM.AGENT_VOICE,
  update_call_settings:     PERM.SETTINGS_EDIT,
  set_call_trigger_enabled: PERM.SETTINGS_EDIT,
  run_scheduler:            PERM.CALLS_MAKE,
  make_call:                "call",
  schedule_call:            "call",
};

async function requiredPermission(name, args, ctx) {
  const p = TOOL_PERMISSIONS[name];
  if (!p) return PERM.DATA_READ;
  if (p !== "call") return p;
  const { rows } = await db.query(
    `SELECT call_type FROM call_trigger_configs WHERE company_id = $1 AND trigger_type = $2 LIMIT 1`,
    [ctx?.companyId, String(args?.trigger_type || "")]
  );
  return permissionForCallType(rows[0]?.call_type ?? null);
}

/**
 * Whether the tool may be OFFERED to the model for this role. Call tools are
 * offered to anyone who can send confirmations; the call type decides at run
 * time (guard below).
 */
function toolAllowedForRole(name, role) {
  const p = TOOL_PERMISSIONS[name];
  if (!p) return hasPermission(role, PERM.DATA_READ);
  if (p === "call") return hasPermission(role, PERM.CONFIRMATIONS_SEND) || hasPermission(role, PERM.CALLS_MAKE);
  return hasPermission(role, p);
}

/** Wrap a handler so it refuses, rather than runs, when the acting role lacks the permission. */
function guarded(h) {
  return async (args, config) => {
    const ctx = config?.configurable?.ctx;
    const needed = await requiredPermission(h.name, args, ctx);
    if (!hasPermission(ctx?.role, needed)) {
      logger.warn("copilot: tool refused for role", { tool: h.name, role: ctx?.role, needed });
      return JSON.stringify({ status: "forbidden", message: `Your role doesn't allow this action (requires ${needed}).` });
    }
    return h.run(args, config);
  };
}

const HANDLERS = [
  // read
  require("./handlers/read/find-customer"),
  require("./handlers/read/get-customer"),
  require("./handlers/read/count-unconfirmed-jobs"),
  require("./handlers/read/count-unconfirmed-appointments-for-customer"),
  require("./handlers/read/list-jobs"),
  require("./handlers/read/list-open-todos"),
  require("./handlers/read/list-calls"),
  require("./handlers/read/get-call"),
  require("./handlers/read/analytics-summary"),
  require("./handlers/read/list-voices"),
  require("./handlers/read/get-agent-config"),
  require("./handlers/read/get-call-settings"),
  require("./handlers/read/find-call-targets"),
  // write
  require("./handlers/write/set-todo-status"),
  require("./handlers/write/update-agent-config"),
  require("./handlers/write/update-call-settings"),
  require("./handlers/write/set-call-trigger-enabled"),
  require("./handlers/write/make-call"),
  require("./handlers/write/schedule-call"),
  require("./handlers/write/run-scheduler"),
];

/**
 * Build the LangChain tool objects for the graph. Tools are tenant-agnostic —
 * each handler reads companyId from config.configurable.ctx at call time — so we
 * build them once and reuse across all tenants/turns.
 *
 * @returns {Promise<{ tools: object[], isWrite: (name: string) => boolean }>}
 */
async function build() {
  let enabled = new Set();
  try {
    enabled = await toolDefsDb.getEnabledNames();
  } catch (err) {
    // Table missing / not seeded yet — fall back to all registered handlers.
    logger.warn("copilot registry: could not read enabled tools, using all handlers", { error: err.message });
    enabled = new Set();
  }

  const chosen = HANDLERS.filter((h) => enabled.size === 0 || enabled.has(h.name));
  const tools = chosen.map((h) =>
    tool(guarded(h), { name: h.name, description: h.description, schema: h.schema })
  );
  const writeNames = new Set(chosen.filter((h) => h.isWrite).map((h) => h.name));

  return { tools, isWrite: (name) => writeNames.has(name) };
}

module.exports = { HANDLERS, TOOL_PERMISSIONS, build, toolAllowedForRole, requiredPermission };
