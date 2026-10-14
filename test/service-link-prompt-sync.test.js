/**
 * "Email the service link after confirmation" (call_settings.service_link_enabled)
 * must change the LIVE Retell prompt directly — adding or removing the SERVICE
 * LINK block — without ever rewriting the stored prompt, which the user may
 * have edited.
 *
 * Runs syncPromptsForCompany / ensureServiceLinkPromptCurrent for real against
 * a fake Retell flow, so what is asserted is the exact text Retell is sent.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const USER_PROMPT = "[Opening]\nHi there — a prompt the user wrote by hand.\n━━━ GENERAL RULES ━━━\n- be nice";
const READ_ONLY = "\n\n[IMPORTANT: You are in read-only mode. Do NOT confirm, reschedule, or create appointments. Collect stuff.]";

let storedPrompt = USER_PROMPT;
let serviceLinkEnabled = false;
let crmSupportsServiceLink = true;
let nodeText = USER_PROMPT;
let failUpdate = false;
const flowUpdates = [];
const syncMarks = [];

stub("db", {
  query: async (sql) => {
    if (/FROM call_type_configs/.test(String(sql))) {
      return { rows: [{ type: "customer_confirmation", begin_message: "", general_prompt: storedPrompt, retell_llm_id: "flow_1", retell_subagent_node_id: "node_cc" }] };
    }
    return { rows: [] };
  },
});
stub("services/retell", {
  getClient: () => ({
    conversationFlow: {
      retrieve: async () => ({ nodes: [{ id: "node_cc", instruction: { type: "prompt", text: nodeText } }] }),
      update: async (_id, { nodes }) => {
        if (failUpdate) throw new Error("Retell is down");
        nodeText = nodes[0].instruction.text;
        flowUpdates.push(nodeText);
      },
    },
  }),
});
stub("db/call-settings", { getByCompanyId: async () => ({ service_link_enabled: serviceLinkEnabled }) });
stub("db/service-line-descriptions", { listByCompany: async () => [] });
stub("services/crm", { resolveSlugForCompany: async () => "servicetrade" });
const { withServiceLinkSetting } = require("../src/confirmation-agent/workflows");
stub("confirmation-agent/workflows", {
  withServiceLinkSetting,
  getWorkflow: () => ({ slug: "servicetrade", capabilities: { serviceLink: crmSupportsServiceLink } }),
});
const realConfigs = require("../src/db/call-type-configs");
stub("db/call-type-configs", {
  ...realConfigs,
  markRetellSync: async (companyId, type, outcome) => { syncMarks.push({ type, ...outcome }); },
});

const promptSync = require("../src/services/prompt-sync");
const { SERVICE_LINK_SECTION, SERVICE_LINK_PROMPT_MARKER } = realConfigs;

test.beforeEach(() => {
  storedPrompt = USER_PROMPT;
  nodeText = USER_PROMPT;
  serviceLinkEnabled = false;
  crmSupportsServiceLink = true;
  failUpdate = false;
  flowUpdates.length = 0;
  syncMarks.length = 0;
});

test("turning the setting ON appends the SERVICE LINK block to the live prompt, user text untouched", async () => {
  serviceLinkEnabled = true;
  const r = await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.deepEqual(r, { ok: true, changed: true, reason: "synced" });
  assert.equal(nodeText, `${USER_PROMPT}\n\n${SERVICE_LINK_SECTION}`);
  assert.equal(storedPrompt, USER_PROMPT, "the stored (editable) prompt is never rewritten");
});

test("turning the setting OFF removes the block from the live prompt", async () => {
  nodeText = `${USER_PROMPT}\n\n${SERVICE_LINK_SECTION}`;
  serviceLinkEnabled = false;
  const r = await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.equal(r.changed, true);
  assert.equal(nodeText, USER_PROMPT);
});

test("setting ON but the CRM has no service link (InspectPoint) → no block", async () => {
  serviceLinkEnabled = true;
  crmSupportsServiceLink = false;
  const r = await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.equal(r.reason, "already_current");
  assert.equal(flowUpdates.length, 0, "Retell not written when nothing changes");
});

test("the read-only note survives, and stays last", async () => {
  nodeText = USER_PROMPT + READ_ONLY;
  serviceLinkEnabled = true;
  await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.equal(nodeText, `${USER_PROMPT}\n\n${SERVICE_LINK_SECTION}${READ_ONLY}`);
});

test("a prompt that already carries the section itself never gets a second copy", async () => {
  storedPrompt = `${USER_PROMPT}\n\n${SERVICE_LINK_SECTION}`;
  nodeText = storedPrompt;
  serviceLinkEnabled = true;
  await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.equal(nodeText.split(SERVICE_LINK_PROMPT_MARKER).length - 1, 1);
});

test("a successful push records retell_synced_at for the call type", async () => {
  serviceLinkEnabled = true;
  await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.deepEqual(syncMarks, [{ type: "customer_confirmation", ok: true }]);
});

test("a Retell failure is reported (never thrown) and recorded on the row", async () => {
  serviceLinkEnabled = true;
  failUpdate = true;
  const r = await promptSync.ensureServiceLinkPromptCurrent(7);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "error");
  assert.deepEqual(syncMarks, [{ type: "customer_confirmation", ok: false, error: "Retell is down" }]);
});

test("composeRetellPrompt only adds the block to customer_confirmation", () => {
  const t = promptSync.composeRetellPrompt("technician_confirmation", "tech prompt", { serviceLinkOn: true });
  assert.equal(t, "tech prompt");
});

test("a service_link_enabled change pushes the prompt BEFORE re-registering tools (both rewrite the same flow)", () => {
  const tools = require("node:fs").readFileSync(require.resolve("../src/services/retell-tools.js"), "utf8");
  const fn = tools.slice(tools.indexOf("async function maybeResyncToolsAfterSettingsChange"));
  const promptAt = fn.indexOf("await ensureServiceLinkPromptCurrent(companyId)");
  const toolsAt = fn.indexOf("await registerToolsForCompany(companyId)");
  assert.ok(promptAt > 0, "prompt push must be awaited");
  assert.ok(toolsAt > promptAt, "tools must be registered after the prompt is pushed");
});

test("the settings route awaits the Retell update instead of firing and forgetting", () => {
  const route = require("node:fs").readFileSync(require.resolve("../src/routes/call-settings.js"), "utf8");
  assert.match(route, /const retellSync = await maybeResyncToolsAfterSettingsChange\(companyId, Object\.keys\(fields\)\)/);
  assert.match(route, /retell_sync: retellSync/);
});
