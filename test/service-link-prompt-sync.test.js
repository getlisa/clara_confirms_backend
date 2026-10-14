/**
 * Toggling "Email the service link after confirmation"
 * (call_settings.service_link_enabled) has to add or remove the SERVICE LINK
 * section of the voice confirmation prompt — not just the tools. Otherwise a
 * company that turned it off keeps an agent that offers to email a link and
 * then has no tool to do it, and one that turned it on gets tools the prompt
 * never mentions.
 *
 * Same structure as previsit-prompt-sync.test.js: the branches that return
 * early are exercised live; the branch that regenerates (resetDefaultPrompts /
 * syncPromptsForCompany via module-local bindings, which no export swap can
 * intercept) is asserted against the source.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
const logger = stub("utils/logger", silentLogger());

const WITH_SECTION = "… CASE B …\n━━━ SERVICE LINK (only AFTER …) ━━━\n… GENERAL RULES …";
const WITHOUT_SECTION = "… CASE B …\n━━━ GENERAL RULES ━━━\n…";

let promptRow = null;
let serviceLinkEnabled = false;
let crmSupportsServiceLink = true;

stub("db", {
  query: async (sql) => {
    if (/FROM call_type_configs/.test(String(sql))) return { rows: promptRow ? [promptRow] : [] };
    return { rows: [] };
  },
});
stub("db/call-settings", { getByCompanyId: async () => ({ service_link_enabled: serviceLinkEnabled }) });
stub("services/retell", { getClient: () => { throw new Error("Retell must not be contacted"); } });
stub("db/service-line-descriptions", { listByCompany: async () => [] });
stub("db/call-type-configs", { BUILTIN_SEEDS: [], generateDefaultPrompts: () => ({ begin_message: "", general_prompt: "" }) });
stub("services/crm", { resolveSlugForCompany: async () => "servicetrade" });
const { withServiceLinkSetting } = require("../src/confirmation-agent/workflows");
stub("confirmation-agent/workflows", {
  withServiceLinkSetting,
  getWorkflow: () => ({ slug: "servicetrade", capabilities: { serviceLink: crmSupportsServiceLink } }),
});

const promptSync = require("../src/services/prompt-sync");

const SRC = require("node:fs").readFileSync(require.resolve("../src/services/prompt-sync.js"), "utf8");
const FN = SRC.slice(SRC.indexOf("async function ensureServiceLinkPromptCurrent"), SRC.indexOf("async function syncPromptsForAllCompanies"));

test.beforeEach(() => {
  logger.reset();
  crmSupportsServiceLink = true;
});

test("setting ON and the prompt already has the section → left alone, Retell not contacted", async () => {
  serviceLinkEnabled = true;
  promptRow = { general_prompt: WITH_SECTION, is_custom: false };
  const r = await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.deepEqual(r, { ok: true, changed: false, reason: "already_current" });
});

test("setting OFF and the prompt has no section → left alone", async () => {
  serviceLinkEnabled = false;
  promptRow = { general_prompt: WITHOUT_SECTION, is_custom: false };
  const r = await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.equal(r.reason, "already_current");
});

test("setting ON but the CRM has no service link → a prompt without the section is already correct", async () => {
  serviceLinkEnabled = true;
  crmSupportsServiceLink = false;
  promptRow = { general_prompt: WITHOUT_SECTION, is_custom: false };
  const r = await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.equal(r.reason, "already_current");
});

test("a custom prompt that disagrees with the setting is reported, never overwritten", async () => {
  serviceLinkEnabled = false;
  promptRow = { general_prompt: WITH_SECTION, is_custom: true };
  const r = await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.deepEqual(r, { ok: false, changed: false, reason: "custom_prompt" });
  assert.equal(logger.records.warn.length, 1);
});

test("a company not provisioned for confirmations is a no-op, not an error", async () => {
  promptRow = null;
  const r = await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.deepEqual(r, { ok: true, changed: false, reason: "no_confirmation_prompt" });
});

test("when it disagrees, it regenerates and pushes ONLY the confirmation prompt", () => {
  assert.match(FN, /await resetDefaultPrompts\(companyId, \["customer_confirmation"\]\)/);
  assert.match(FN, /await syncPromptsForCompany\(companyId, \["customer_confirmation"\]\)/);
});

test("a service_link_enabled change regenerates the prompt BEFORE re-registering tools (both rewrite the same flow)", () => {
  const tools = require("node:fs").readFileSync(require.resolve("../src/services/retell-tools.js"), "utf8");
  const fn = tools.slice(tools.indexOf("async function maybeResyncToolsAfterSettingsChange"));
  const promptAt = fn.indexOf("await ensureServiceLinkPromptCurrent(companyId)");
  const toolsAt = fn.indexOf("await registerToolsForCompany(companyId)");
  assert.ok(promptAt > 0, "prompt regeneration must be awaited");
  assert.ok(toolsAt > promptAt, "tools must be registered after the prompt is regenerated");
  assert.match(fn, /changedFieldNames\.includes\("service_link_enabled"\)/);
});
