/**
 * Authoring an instruction has to leave the agent ABLE TO SAY IT.
 *
 * The instruction text never enters the prompt — it rides per-call in
 * retell_llm_dynamic_variables. What the prompt must carry is the step that
 * delivers it. If that is missing the variable is still bound and then
 * silently ignored: the row saves, the UI shows it, the API returns 201, and
 * the customer is never told to turn the fryers off. Nothing looks wrong.
 *
 * These cover the repair, and equally that it does NOT fire when it shouldn't —
 * a prompt reset regenerates wholesale, so firing needlessly would rewrite a
 * company's whole agent prompt as a side effect of a settings write.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
const logger = stub("utils/logger", silentLogger());

const WITH_MARKER = "… STEP 5 … {{previsit_instructions}} … rest of prompt";
const WITHOUT_MARKER = "… an older generation of the prompt, no pre-visit step …";

let promptRow = null;
const calls = { query: [] };

stub("db", {
  query: async (sql, params) => {
    calls.query.push({ sql: String(sql).replace(/\s+/g, " "), params });
    if (/FROM call_type_configs/.test(String(sql))) {
      return { rows: promptRow ? [promptRow] : [] };
    }
    return { rows: [] };
  },
});

// prompt-sync pulls these in at module load; none should be reached in the
// no-op path, which is itself part of what is under test.
stub("services/retell", { getClient: () => { throw new Error("Retell must not be contacted"); } });
stub("db/service-line-descriptions", { listByCompany: async () => [] });
stub("db/call-type-configs", { BUILTIN_SEEDS: [], generateDefaultPrompts: () => ({ begin_message: "", general_prompt: "" }) });
stub("services/crm", { resolveSlugForCompany: async () => "servicetrade" });
stub("confirmation-agent/workflows", { getWorkflow: () => ({}) });

const promptSync = require("../src/services/prompt-sync");

// ensurePrevisitPromptCurrent calls resetDefaultPrompts/syncPromptsForCompany
// through module-local bindings, which no export-level swap can intercept. So
// the branches that DO call them are asserted against the source below, and the
// live assertions here cover only the branches that return before that point —
// which is also where the behaviour that matters most (never firing needlessly,
// never throwing) lives.
const SRC = require("node:fs").readFileSync(require.resolve("../src/services/prompt-sync.js"), "utf8");
const FN = SRC.slice(SRC.indexOf("async function ensurePrevisitPromptCurrent"), SRC.indexOf("async function syncPromptsForAllCompanies"));

test.beforeEach(() => {
  calls.query.length = 0;
  logger.reset();
});

test("a prompt that already has the step is left completely alone", async () => {
  promptRow = { general_prompt: WITH_MARKER, is_custom: false };
  const r = await promptSync.ensurePrevisitPromptCurrent(7);
  assert.deepEqual(r, { ok: true, changed: false, reason: "already_current" });
  // One indexed read and nothing else — no regeneration, no Retell traffic.
  assert.equal(calls.query.length, 1, "exactly one query in the common path");
});

test("a company with no confirmation prompt is not an error", async () => {
  promptRow = null;
  const r = await promptSync.ensurePrevisitPromptCurrent(7);
  assert.equal(r.ok, true, "the instruction is stored and becomes live if they are provisioned");
  assert.equal(r.changed, false);
  assert.equal(r.reason, "no_confirmation_prompt");
});

test("a hand-written prompt is NEVER overwritten, and the gap is reported", async () => {
  // resetDefaultPrompts deliberately skips is_custom rows, so repairing here
  // would either do nothing or throw away someone's work.
  promptRow = { general_prompt: WITHOUT_MARKER, is_custom: true };
  const r = await promptSync.ensurePrevisitPromptCurrent(7);
  assert.equal(r.ok, false, "reported as not ok — the instruction will not be spoken");
  assert.equal(r.reason, "custom_prompt");
  // Only one read happened — it returned before regenerating anything.
  assert.equal(calls.query.length, 1, "nothing was regenerated");
  assert.equal(logger.records.warn.length, 1, "and it warns rather than failing silently");
});

test("a failure NEVER throws — the row is already committed", async () => {
  // A Retell outage must not turn a saved setting into a 500.
  promptRow = { get general_prompt() { throw new Error("boom"); }, is_custom: false };
  const r = await promptSync.ensurePrevisitPromptCurrent(7);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "error");
  assert.equal(logger.records.error.length, 1, "logged loudly instead");
});

// ── the repair branch, asserted on the code that performs it ─────────────────

test("a missing step triggers a regenerate AND a push to Retell", () => {
  assert.ok(/await resetDefaultPrompts\(companyId, \["customer_confirmation"\]\)/.test(FN),
    "the stored prompt is brought current");
  assert.ok(/await syncPromptsForCompany\(companyId, \["customer_confirmation"\]\)/.test(FN),
    "and pushed — a stored prompt the agent never receives is no repair at all");
  // Scoped to the one call type: regenerating every type would rewrite
  // technician prompts as a side effect of a customer setting.
  assert.ok(!/resetDefaultPrompts\(companyId\)[^,]/.test(FN), "scoped, not company-wide");
});

test("the repair is loud, because it also carries unrelated prompt changes forward", () => {
  // A company on an older generation gets every accumulated change, not just
  // this block. That is a real side effect and must be visible in the logs.
  assert.ok(/logger\.info\([\s\S]{0,200}changed: true/.test(FN), "logged at info with changed:true");
  assert.ok(/regenerates it wholesale/.test(SRC), "and the reason is recorded where someone would look");
});

test("the marker is the variable itself, so it cannot drift from the prompt", () => {
  // Keying on a heading would let the two diverge silently; the variable IS
  // the thing whose absence breaks delivery.
  assert.equal(promptSync.PREVISIT_PROMPT_MARKER, "{{previsit_instructions}}");
});

// ── the route reports the outcome ────────────────────────────────────────────

test("create and update both ensure the prompt, and surface the result", () => {
  const routeSrc = require("node:fs").readFileSync(require.resolve("../src/routes/job-type-instructions.js"), "utf8");
  const ensureCalls = routeSrc.match(/await ensurePrevisitPromptCurrent\(companyId\)/g) || [];
  assert.equal(ensureCalls.length, 2, "on POST and on PATCH");
  assert.ok(/res\.status\(201\)\.json\(\{ instruction, prompt_sync: promptSync \}\)/.test(routeSrc),
    "the outcome is returned, not swallowed — the UI can warn when ok is false");
  // It must run AFTER the write: the row has to survive a Retell failure.
  const createAt = routeSrc.indexOf("jobTypeInstructionsDb.create");
  const ensureAt = routeSrc.indexOf("ensurePrevisitPromptCurrent", createAt);
  assert.ok(ensureAt > createAt, "the row is committed before the prompt is touched");
});
