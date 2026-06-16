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
    tool(h.run, { name: h.name, description: h.description, schema: h.schema })
  );
  const writeNames = new Set(chosen.filter((h) => h.isWrite).map((h) => h.name));

  return { tools, isWrite: (name) => writeNames.has(name) };
}

module.exports = { HANDLERS, build };
