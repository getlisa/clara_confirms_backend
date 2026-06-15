/**
 * Seed copilot_tool_definitions from the JS handler registry. The table is the
 * enable/disable + catalog layer; behaviour lives in the handlers. Run via:
 *   node -e "require('./src/copilot/tools/seeds').seedAll().then(()=>process.exit(0))"
 */

const { HANDLERS } = require("./registry");
const toolDefsDb = require("../../db/copilot-tool-definitions");
const logger = require("../../utils/logger");

async function seedAll() {
  let i = 0;
  for (const h of HANDLERS) {
    await toolDefsDb.upsert({
      name: h.name,
      description: h.description,
      // The zod schema is the runtime source of truth; we store a lightweight
      // marker here (the catalog table is for enable/disable + listing).
      parameters: h.paramsDoc ?? {},
      is_write_tool: !!h.isWrite,
      sort_order: i++,
    });
  }
  logger.info("Copilot tool definitions seeded", { count: HANDLERS.length });
  return { count: HANDLERS.length };
}

module.exports = { seedAll };
