/**
 * Sync prompts and tools from code/DB → Retell conversation flow nodes.
 *
 * Usage:
 *   node scripts/sync-prompts.js                          # sync prompts, all companies
 *   node scripts/sync-prompts.js --reset                  # reset DB prompts to defaults, then sync all
 *   node scripts/sync-prompts.js --tools                  # reseed tool_definitions + register on all flows
 *   node scripts/sync-prompts.js --reset --tools          # reset everything for all companies
 *   node scripts/sync-prompts.js --company 4              # one company only
 *   node scripts/sync-prompts.js --type customer_confirmation,quotation_followup
 */
require("dotenv").config();
const {
  resetDefaultPrompts,
  resetDefaultPromptsForAllCompanies,
  syncPromptsForCompany,
  syncPromptsForAllCompanies,
} = require("../src/services/prompt-sync");
const { registerToolsForCompany, registerToolsForAllCompanies } = require("../src/services/retell-tools");
const toolDefsDb = require("../src/db/tool-definitions");

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}
const hasFlag = (flag) => args.includes(flag);

const companyArg = getArg("--company");
const typeArg    = getArg("--type");
const doReset    = hasFlag("--reset");
const doTools    = hasFlag("--tools");
const types      = typeArg ? typeArg.split(",").map(t => t.trim()) : null;

async function run() {
  // Step 1 (optional): reseed tool_definitions table then register on Retell flows
  if (doTools) {
    await toolDefsDb.seedAll();
    console.log(`Tool definitions seeded (${toolDefsDb.TOOL_SEEDS.length} tools)`);

    if (companyArg) {
      const r = await registerToolsForCompany(Number(companyArg));
      console.log(`Registered tools — company ${companyArg}: ${r?.updated ?? 0} node(s) updated`);
    } else {
      const r = await registerToolsForAllCompanies();
      console.log(`Registered tools — all companies: ${r.total} node(s) updated`);
    }
  }

  // Step 2 (optional): reset DB prompts to current code defaults
  if (doReset) {
    if (companyArg) {
      const r = await resetDefaultPrompts(Number(companyArg), types);
      console.log(`Reset DB prompts — company ${companyArg}: ${r.updated} type(s) updated`);
    } else {
      const r = await resetDefaultPromptsForAllCompanies(types);
      console.log(`Reset DB prompts — all companies: ${r.total} type(s) updated`);
    }
  }

  // Step 3: push DB prompts → Retell
  if (companyArg) {
    const r = await syncPromptsForCompany(Number(companyArg), types);
    console.log(`Synced prompts — company ${companyArg}: ${r.updated} node(s) updated`);
  } else {
    const r = await syncPromptsForAllCompanies(types);
    console.log(`Synced prompts — all companies: ${r.total} node(s) updated`);
  }
}

run().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
