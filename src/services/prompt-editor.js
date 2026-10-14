/**
 * The agent prompt editor: users edit a call type's prompt from the platform,
 * and the save goes straight to the live Retell agent.
 *
 * What is editable, and what is not
 * ─────────────────────────────────
 * The user edits call_type_configs.general_prompt — the whole instruction text
 * of that call type's Retell node, including its [Opening] line. Two blocks
 * are NOT part of it and are never stored in it; prompt-sync.js's
 * composeRetellPrompt appends them when it pushes to Retell:
 *
 *   service_link — customer_confirmation only, while the company's CRM supports
 *                  a service link AND call_settings.service_link_enabled
 *                  ("Email the service link after confirmation") is on.
 *   read_only    — every node, while call_settings.agent_can_make_changes is off.
 *
 * Keeping them out of the editable text is what lets those settings change the
 * live agent without ever rewriting what the user wrote. The editor shows them
 * read-only (getEditorView's managed_blocks) so nobody is surprised by them.
 *
 * begin_message is NOT used: syncPromptsForCompany pushes general_prompt only,
 * so the opening line lives in the prompt's own [Opening] section.
 *
 * Saving
 * ──────
 * DB first (atomically with a revision row, version-checked), then Retell,
 * awaited. A Retell failure does not undo the save: the response says so, the
 * row carries retell_sync_error, and syncToRetell() retries.
 */

const callTypeConfigsDb = require("../db/call-type-configs");
const callSettingsDb = require("../db/call-settings");
const dynamicVarsDb = require("../db/dynamic-variable-definitions");
const promptSync = require("./prompt-sync");
const { READ_ONLY_NOTE } = require("./retell-tools");
const { getWorkflow } = require("../confirmation-agent/workflows");
const { resolveSlugForCompany } = require("./crm");
const logger = require("../utils/logger");

const MAX_PROMPT_CHARS = 60000;
const MIN_PROMPT_CHARS = 20;

function httpError(status, message, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function variablesIn(text) {
  const names = new Set();
  for (const m of String(text || "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) names.add(m[1]);
  return names;
}

/**
 * Check a prompt before it is saved. `errors` block the save (400);
 * `warnings` are shown to the user but do not.
 *
 * @returns {Promise<{valid: boolean, errors: object[], warnings: object[]}>}
 */
async function validatePrompt(companyId, type, generalPrompt) {
  const errors = [];
  const warnings = [];

  if (typeof generalPrompt !== "string") {
    errors.push({ code: "not_a_string", message: "general_prompt must be a string" });
    return { valid: false, errors, warnings };
  }
  const trimmed = generalPrompt.trim();
  if (trimmed.length < MIN_PROMPT_CHARS) {
    errors.push({ code: "too_short", message: `The prompt must be at least ${MIN_PROMPT_CHARS} characters` });
  }
  if (generalPrompt.length > MAX_PROMPT_CHARS) {
    errors.push({ code: "too_long", message: `The prompt must be at most ${MAX_PROMPT_CHARS} characters (it is ${generalPrompt.length})` });
  }

  // {{variables}} Retell will not fill render literally on the call.
  const known = new Set((await dynamicVarsDb.getAll()).map((v) => v.name));
  const used = variablesIn(generalPrompt);
  const unknown = [...used].filter((n) => !known.has(n));
  if (unknown.length) {
    warnings.push({
      code: "unknown_variables",
      message: "These variables are not filled in on calls, so the agent would see them as literal text",
      variables: unknown,
    });
  }

  // Variables the default prompt relies on that this version dropped — most
  // matter (job_id / appointment ids are what the agent's tools act on).
  const def = await promptSync.buildDefaultPromptForCompany(companyId, type);
  if (def) {
    const missing = [...variablesIn(def.general_prompt)].filter((n) => !used.has(n));
    if (missing.length) {
      warnings.push({
        code: "default_variables_missing",
        message: "The default prompt uses these variables and this version does not — the agent will not see that information",
        variables: missing,
      });
    }
  }

  if ((generalPrompt.match(/\{\{/g) || []).length !== (generalPrompt.match(/\}\}/g) || []).length) {
    warnings.push({ code: "unbalanced_braces", message: "There are unmatched {{ or }} in the prompt" });
  }

  if (type === "customer_confirmation" && generalPrompt.includes(callTypeConfigsDb.SERVICE_LINK_PROMPT_MARKER)) {
    warnings.push({
      code: "contains_managed_section",
      message: "The SERVICE LINK section is added automatically when \"Email the service link after confirmation\" is on. Keeping a copy here means it stays even when that setting is off.",
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** The managed blocks for this company + call type, as the editor shows them. */
async function managedBlocks(companyId, type) {
  const settings = await callSettingsDb.getByCompanyId(companyId);
  const blocks = [];
  if (type === "customer_confirmation") {
    const crmSupports = getWorkflow(await resolveSlugForCompany(companyId)).capabilities?.serviceLink !== false;
    const settingOn = settings?.service_link_enabled === true;
    blocks.push({
      key: "service_link",
      title: "Service link (email after confirmation)",
      active: crmSupports && settingOn,
      reason: !crmSupports ? "crm_unsupported" : settingOn ? "enabled" : "setting_off",
      controlled_by: "call_settings.service_link_enabled",
      text: callTypeConfigsDb.SERVICE_LINK_SECTION,
    });
  }
  const readOnly = settings?.agent_can_make_changes === false;
  blocks.push({
    key: "read_only",
    title: "Read-only mode",
    active: readOnly,
    reason: readOnly ? "enabled" : "setting_off",
    controlled_by: "call_settings.agent_can_make_changes",
    text: READ_ONLY_NOTE.trim(),
  });
  return blocks;
}

/** Everything the editor screen needs for one call type. */
async function getEditorView(companyId, type) {
  const callType = await callTypeConfigsDb.getByType(companyId, type);
  if (!callType) throw httpError(404, "Call type not found");

  const [def, blocks] = await Promise.all([
    promptSync.buildDefaultPromptForCompany(companyId, type),
    managedBlocks(companyId, type),
  ]);
  const serviceLinkOn = blocks.some((b) => b.key === "service_link" && b.active);
  const readOnlyOn = blocks.some((b) => b.key === "read_only" && b.active);

  return {
    call_type: callType,
    default_prompt: def ? def.general_prompt : null,
    is_default: def ? callType.general_prompt === def.general_prompt : false,
    managed_blocks: blocks,
    effective_prompt: promptSync.composeRetellPrompt(type, callType.general_prompt, {
      serviceLinkOn,
      readOnlyNote: readOnlyOn ? READ_ONLY_NOTE : "",
    }),
    limits: { min_chars: MIN_PROMPT_CHARS, max_chars: MAX_PROMPT_CHARS },
  };
}

/**
 * Push the stored prompt of one call type to Retell. Never throws.
 * @returns {Promise<{status: "synced"|"unchanged"|"not_provisioned"|"failed", synced_at?: string, error?: string}>}
 */
async function syncToRetell(companyId, type) {
  try {
    const { updated, synced_types: synced = [] } = await promptSync.syncPromptsForCompany(companyId, [type]);
    if (!synced.includes(type)) return { status: "not_provisioned" };
    const row = await callTypeConfigsDb.getByType(companyId, type);
    return { status: updated > 0 ? "synced" : "unchanged", synced_at: row?.retell_synced_at ?? null };
  } catch (err) {
    logger.error("prompt-editor: Retell sync failed", { companyId, type, error: err.message });
    return { status: "failed", error: err.message };
  }
}

/**
 * Save `generalPrompt` (validated, version-checked, with a revision) and push
 * it to Retell. prompt_customized ends up true unless the text is exactly the
 * current default — so saving the default back hands the prompt back to
 * automatic updates.
 */
async function savePromptAndSync(companyId, type, { generalPrompt, expectedVersion = null, userId = null, source = "edit" }) {
  const existing = await callTypeConfigsDb.getByType(companyId, type);
  if (!existing) throw httpError(404, "Call type not found");

  const validation = await validatePrompt(companyId, type, generalPrompt);
  if (!validation.valid) throw httpError(400, validation.errors[0].message, { validation });

  const def = await promptSync.buildDefaultPromptForCompany(companyId, type);
  const customized = !def || generalPrompt !== def.general_prompt;

  const saved = await callTypeConfigsDb.savePrompt(companyId, type, {
    generalPrompt, expectedVersion, userId, source, customized,
  });
  if (!saved) throw httpError(404, "Call type not found");
  logger.info("prompt-editor: prompt saved", { companyId, type, version: saved.prompt_version, source, customized, userId });

  const retell_sync = await syncToRetell(companyId, type);
  const call_type = await callTypeConfigsDb.getByType(companyId, type);
  return { call_type, retell_sync, warnings: validation.warnings };
}

/** "Reset to default": write the current default and hand the prompt back to automatic updates. */
async function resetToDefault(companyId, type, { expectedVersion = null, userId = null } = {}) {
  const def = await promptSync.buildDefaultPromptForCompany(companyId, type);
  if (!def) throw httpError(404, "Call type not found");
  return savePromptAndSync(companyId, type, { generalPrompt: def.general_prompt, expectedVersion, userId, source: "reset" });
}

/** Make an earlier revision the current prompt again (as a new version). */
async function restoreRevision(companyId, type, revisionId, { expectedVersion = null, userId = null } = {}) {
  const revision = await callTypeConfigsDb.getRevision(companyId, type, revisionId);
  if (!revision) throw httpError(404, "Revision not found");
  return savePromptAndSync(companyId, type, { generalPrompt: revision.general_prompt, expectedVersion, userId, source: "restore" });
}

module.exports = {
  MAX_PROMPT_CHARS,
  MIN_PROMPT_CHARS,
  validatePrompt,
  getEditorView,
  syncToRetell,
  savePromptAndSync,
  resetToDefault,
  restoreRevision,
};
