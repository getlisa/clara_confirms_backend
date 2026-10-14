/**
 * services/prompt-editor.js — users edit the agent prompt from the platform and
 * the save goes straight to Retell. These pin the contract the frontend relies
 * on (docs/prompt-editor-frontend.md).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const DEFAULT = "[Opening]\nDefault prompt for {{job_id}} with {{customer_name}} and enough words to pass.";
let row;
let syncResult;
const saves = [];

function freshRow() {
  return {
    type: "customer_confirmation", general_prompt: DEFAULT, prompt_version: 3, prompt_customized: false,
    retell_synced_at: "2026-10-14T00:00:00Z", retell_sync_error: null,
  };
}

stub("db/call-type-configs", {
  SERVICE_LINK_PROMPT_MARKER: "━━━ SERVICE LINK",
  SERVICE_LINK_SECTION: "━━━ SERVICE LINK (managed) ━━━\nblock",
  getByType: async (_c, type) => (type === "customer_confirmation" ? { ...row } : null),
  savePrompt: async (_c, _t, args) => {
    if (args.expectedVersion != null && args.expectedVersion !== row.prompt_version) {
      const err = new Error("conflict"); err.status = 409; err.current = { ...row }; throw err;
    }
    saves.push(args);
    row = { ...row, general_prompt: args.generalPrompt, prompt_customized: args.customized, prompt_version: row.prompt_version + 1 };
    return { ...row };
  },
  getRevision: async (_c, _t, id) => (id === 11 ? { id: 11, general_prompt: "[Opening]\nAn older version of the prompt for {{job_id}} {{customer_name}}." } : null),
});
stub("db/call-settings", { getByCompanyId: async () => ({ service_link_enabled: true, agent_can_make_changes: false }) });
stub("db/dynamic-variable-definitions", { getAll: async () => [{ name: "job_id" }, { name: "customer_name" }] });
stub("services/prompt-sync", {
  buildDefaultPromptForCompany: async () => ({ begin_message: "", general_prompt: DEFAULT }),
  composeRetellPrompt: (type, text, { serviceLinkOn, readOnlyNote }) => text + (serviceLinkOn ? "\n\n[SL]" : "") + (readOnlyNote || ""),
  syncPromptsForCompany: async () => {
    if (syncResult instanceof Error) throw syncResult;
    return syncResult;
  },
});
stub("services/retell-tools", { READ_ONLY_NOTE: "\n\n[READ ONLY]" });
stub("services/crm", { resolveSlugForCompany: async () => "servicetrade" });
stub("confirmation-agent/workflows", { getWorkflow: () => ({ capabilities: { serviceLink: true } }) });

const editor = require("../src/services/prompt-editor");

test.beforeEach(() => {
  row = freshRow();
  syncResult = { updated: 1, synced_types: ["customer_confirmation"] };
  saves.length = 0;
});

test("a prompt that is too short is rejected before anything is saved", async () => {
  await assert.rejects(editor.savePromptAndSync(7, "customer_confirmation", { generalPrompt: "hi" }), (e) => e.status === 400 && e.validation.errors[0].code === "too_short");
  assert.equal(saves.length, 0);
});

test("unknown {{variables}} and dropped default variables are warnings, not errors", async () => {
  const v = await editor.validatePrompt(7, "customer_confirmation", "Talk to {{customer_nmae}} about the visit, kindly and briefly.");
  assert.equal(v.valid, true);
  const codes = v.warnings.map((w) => w.code);
  assert.ok(codes.includes("unknown_variables"));
  assert.deepEqual(v.warnings.find((w) => w.code === "unknown_variables").variables, ["customer_nmae"]);
  assert.deepEqual(v.warnings.find((w) => w.code === "default_variables_missing").variables, ["job_id", "customer_name"]);
});

test("pasting the managed SERVICE LINK section in is flagged", async () => {
  const v = await editor.validatePrompt(7, "customer_confirmation", `${DEFAULT}\n━━━ SERVICE LINK copy`);
  assert.ok(v.warnings.some((w) => w.code === "contains_managed_section"));
});

test("an edit saves as customized, pushes to Retell, and reports it", async () => {
  const r = await editor.savePromptAndSync(7, "customer_confirmation", { generalPrompt: `${DEFAULT} Extra rule.`, expectedVersion: 3, userId: 5 });
  assert.equal(saves[0].customized, true);
  assert.equal(saves[0].source, "edit");
  assert.equal(saves[0].userId, 5);
  assert.equal(r.retell_sync.status, "synced");
  assert.equal(r.call_type.prompt_version, 4);
});

test("saving text identical to the default hands the prompt back to automatic updates", async () => {
  await editor.savePromptAndSync(7, "customer_confirmation", { generalPrompt: DEFAULT });
  assert.equal(saves[0].customized, false);
});

test("a stale expected_version surfaces as a 409 carrying the current row", async () => {
  await assert.rejects(
    editor.savePromptAndSync(7, "customer_confirmation", { generalPrompt: `${DEFAULT} x`, expectedVersion: 2 }),
    (e) => e.status === 409 && e.current.prompt_version === 3,
  );
});

test("a Retell failure does not lose the save — it is reported as failed", async () => {
  syncResult = new Error("Retell is down");
  const r = await editor.savePromptAndSync(7, "customer_confirmation", { generalPrompt: `${DEFAULT} y` });
  assert.equal(saves.length, 1);
  assert.deepEqual(r.retell_sync, { status: "failed", error: "Retell is down" });
});

test("an agent not provisioned in Retell yet saves fine and says so", async () => {
  syncResult = { updated: 0, synced_types: [] };
  const r = await editor.savePromptAndSync(7, "customer_confirmation", { generalPrompt: `${DEFAULT} z` });
  assert.equal(r.retell_sync.status, "not_provisioned");
});

test("reset writes the default with source 'reset' and clears customized", async () => {
  row.general_prompt = "[Opening]\nsomething the user wrote, long enough to count.";
  row.prompt_customized = true;
  await editor.resetToDefault(7, "customer_confirmation", { userId: 5 });
  assert.equal(saves[0].generalPrompt, DEFAULT);
  assert.equal(saves[0].source, "reset");
  assert.equal(saves[0].customized, false);
});

test("restore saves the revision's text as a new version", async () => {
  await editor.restoreRevision(7, "customer_confirmation", 11, {});
  assert.match(saves[0].generalPrompt, /An older version/);
  assert.equal(saves[0].source, "restore");
  await assert.rejects(editor.restoreRevision(7, "customer_confirmation", 999, {}), (e) => e.status === 404);
});

test("the editor view shows managed blocks and the exact text Retell gets", async () => {
  const v = await editor.getEditorView(7, "customer_confirmation");
  assert.equal(v.is_default, true);
  assert.deepEqual(v.managed_blocks.map((b) => [b.key, b.active, b.reason]), [["service_link", true, "enabled"], ["read_only", true, "enabled"]]);
  assert.equal(v.effective_prompt, `${DEFAULT}\n\n[SL]\n\n[READ ONLY]`);
  await assert.rejects(editor.getEditorView(7, "nope"), (e) => e.status === 404);
});
