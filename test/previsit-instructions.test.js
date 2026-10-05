/**
 * Pre-visit instructions by job type (CMAP-230).
 *
 * These are the one thing in a confirmation call the customer has to act on
 * themselves, and a visit fails outright if one is missed — "the team can't
 * inspect with fryers on". Two failure modes are worth more than the rest:
 *
 *   1. An instruction leaking into the OPENING message, or being delivered
 *      when there is no visit — telling someone to turn their fryers off on a
 *      call that ended in a cancellation.
 *   2. An instruction being presented as OPTIONAL. The open-issue variables
 *      (CMAP-228) sit right beside these in the same prompt and ARE optional
 *      repair work being offered; if the two blur, the agent offers "turn the
 *      fryers off" as something declinable.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

// ── the resolver ─────────────────────────────────────────────────────────────

const queries = [];
stub("db", {
  query: async (sql, params) => {
    queries.push({ sql: String(sql).replace(/\s+/g, " "), params });
    return { rows: [] };
  },
});

const jti = require("../src/db/job-type-instructions");

test("the job_type key is normalised on BOTH sides, or a picker value never matches", () => {
  // The picker returns lower(btrim(job_type)); a hand-typed value will not.
  assert.equal(jti.normalizeJobType("  Fire Suppression  "), "fire suppression");
  assert.equal(jti.normalizeJobType("FIRE SUPPRESSION"), "fire suppression");
});

test("a blank or missing job_type resolves to NOTHING, never to everything", async () => {
  // 32 of company 14's jobs have no job_type at all. The dangerous bug here is
  // a resolver that treats "no type" as "match all" — a typeless job would
  // inherit every instruction the company has ever written.
  for (const value of [null, undefined, "", "   "]) {
    queries.length = 0;
    const rows = await jti.listForJobType(11, value);
    assert.deepEqual(rows, [], `${JSON.stringify(value)} must resolve to []`);
    assert.equal(queries.length, 0, "and must not even reach the database");
  }
});

test("the resolver reads only ACTIVE rows for the one company", async () => {
  queries.length = 0;
  await jti.listForJobType(11, "Fire Suppression");
  const q = queries.find((x) => /FROM job_type_instructions/.test(x.sql));
  assert.ok(q, "the lookup ran");
  assert.ok(/company_id = \$1/.test(q.sql), "scoped to the company");
  assert.ok(/AND active/.test(q.sql), "a deactivated instruction is never spoken");
  assert.deepEqual(q.params, [11, "fire suppression"], "the key is passed normalised");
});

test("the picker offers only job types the company's jobs really have", async () => {
  queries.length = 0;
  await jti.listJobTypeOptions(11);
  const q = queries.find((x) => /FROM jobs/.test(x.sql));
  assert.ok(/lower\(btrim\(job_type\)\)/.test(q.sql), "returns the same normalised key the resolver matches on");
  assert.ok(/job_type IS NOT NULL/.test(q.sql), "a null type is not an option");
  assert.ok(/count\(\*\)/.test(q.sql), "with counts — the values are CRM free text and the user needs to see which are real");
});

// ── the dynamic variables ────────────────────────────────────────────────────

const ctxSrc = fs.readFileSync(require.resolve("../src/services/job-confirmation-context.js"), "utf8");

/** Assert on CODE, not on the explanatory comments around it. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("all three variables are emitted unconditionally, including the zero case", () => {
  const code = stripComments(ctxSrc);
  // A variable Retell was never given renders as the literal "{{name}}" in the
  // prompt, so the zero case must be a real value the prompt can branch on.
  assert.ok(/previsit_instruction_count: String\(previsit\.length\)/.test(code),
    "count is always a string, never undefined");
  for (const name of ["previsit_instructions", "previsit_must_acknowledge"]) {
    const m = code.match(new RegExp(`${name}: [^,]*\\n?[^,]*: "none"`, "m"))
      || code.match(new RegExp(`${name}:[\\s\\S]{0,220}?: "none"`));
    assert.ok(m, `${name} falls back to "none", not to a blank`);
  }
});

test("instructions are pipe-joined and truncated, like every other list variable", () => {
  const code = stripComments(ctxSrc);
  // job_comments and open_issue_details already established this: dynamic
  // variables are string-only and a stringified array reads aloud as
  // punctuation. A new separator here would be a third convention.
  assert.ok(/previsit\.map\(\(i\) => i\.instruction\)\.join\(" \| "\)/.test(code));
  assert.ok(/truncate\(previsit\.map[\s\S]{0,80}MAX_COMMENT_CHARS\)/.test(code),
    "truncated — 500 chars covers every instruction for one job type, not one instruction");
});

test("must_acknowledge is the flagged SUBSET, not a copy of everything", () => {
  const code = stripComments(ctxSrc);
  assert.ok(/mustAck = previsit\.filter\(\(i\) => i\.requires_acknowledgement === true\)/.test(code),
    "strict true — a null or undefined flag must not make an instruction blocking");
});

test("a failed lookup degrades to [] instead of killing the call", () => {
  // The call has every reason to happen without an optional extra.
  const region = ctxSrc.slice(ctxSrc.indexOf("listForJobType"), ctxSrc.indexOf("listForJobType") + 500);
  assert.ok(/\.catch\(/.test(region), "the lookup is guarded");
  assert.ok(/return \[\]/.test(region), "and yields an empty list, not a rejection");
});

// ── the voice prompt ─────────────────────────────────────────────────────────

const promptSrc = fs.readFileSync(require.resolve("../src/db/call-type-configs.js"), "utf8");

test("the voice prompt delivers instructions only AFTER the visit is settled", () => {
  assert.ok(/STEP 5 — What they need to do before the visit/.test(promptSrc), "the step exists");
  const step5 = promptSrc.slice(promptSrc.indexOf("STEP 5 — What they need"), promptSrc.indexOf("━━━ GENERAL RULES"));
  assert.ok(/Only when \{\{previsit_instruction_count\}\} is greater than 0/.test(step5),
    "gated on there being any — a company with none gets no step");
  assert.ok(/Skip it entirely if they cancelled/.test(step5),
    "never delivered when there is no visit to prepare for");
  // The data block must say the same thing, since the model reads it first.
  assert.ok(/Deliver them in STEP 5, after the appointment is settled\. Never in the opening message\./.test(promptSrc),
    "and the data block repeats the timing, where the variables are introduced");
});

test("the prompt forbids presenting an instruction as optional", () => {
  const step5 = promptSrc.slice(promptSrc.indexOf("STEP 5 — What they need"), promptSrc.indexOf("━━━ GENERAL RULES"));
  assert.ok(/never describe one as optional/i.test(step5), "stated explicitly");
  assert.ok(/may not add, soften, drop or extend/i.test(step5), "and the agent may not reword it away");
  assert.ok(/WAIT for a clear yes/.test(step5), "a flagged instruction is waited on, not read past");
  assert.ok(/Never threaten a fee or imply a penalty/.test(step5), "but it is not enforced by threat either");
});

test("pre-visit requirements are kept distinct from the open-issue OFFER", () => {
  // These two sit beside each other in one prompt and mean opposite things:
  // an open issue is optional repair work being offered, a pre-visit
  // instruction is a precondition. If they blur, the agent offers "turn the
  // fryers off" as declinable.
  const block = promptSrc.slice(
    promptSrc.indexOf("━━━ WHAT THE CUSTOMER MUST DO BEFORE THE VISIT ━━━"),
    promptSrc.indexOf("━━━ YOUR MAIN WORKFLOW ━━━"));
  assert.ok(/NOT findings, NOT repair work, and NOT optional/.test(block),
    "the distinction is drawn where the variables are introduced");
  // The open-items offer must stay an offer.
  const step4 = promptSrc.slice(promptSrc.indexOf("STEP 4 — Open items"), promptSrc.indexOf("STEP 5 — What they need"));
  assert.ok(/This is an OFFER, not a negotiation/.test(step4), "and STEP 4 stays an offer");
});

test("the goodbye gate covers the new step, or it can be silently skipped", () => {
  assert.ok(/STEP 4 and STEP 5 have each been handled or established not to apply/.test(promptSrc));
});

// ── the CMAP-228 durability fix ──────────────────────────────────────────────

test("the open-items block lives in CODE, not hand-baked into a stored prompt", () => {
  // It previously existed only as a hand-edited call_type_configs row for
  // company 11. prompt-sync.js's own header documents why that breaks:
  // resetDefaultPrompts regenerates from generateDefaultPrompts, so anything
  // baked into the stored prompt is silently dropped with no way back. This
  // test is the regression guard for that, not for the text itself.
  assert.ok(/━━━ OPEN ITEMS AT THIS SITE ━━━/.test(promptSrc),
    "the block is generated from code, so a prompt reset cannot lose it");
  assert.ok(/STEP 4 — Open items at the site/.test(promptSrc));
  // And it must be inert for the companies that have no deficiencies at all.
  assert.ok(/is \\"0\\" or blank, this site has none — say nothing about open items at all/.test(promptSrc),
    "self-disabling, so it is safe to give every company");
});

test("neither block bakes in per-company data", () => {
  // The moment real instruction text or a real site name is interpolated into
  // generateDefaultPrompts, every company shares one company's data and a
  // reset stops being idempotent. Both blocks must be pure static text over
  // dynamic variables.
  const start = promptSrc.indexOf("━━━ OPEN ITEMS AT THIS SITE ━━━");
  const end = promptSrc.indexOf("━━━ YOUR MAIN WORKFLOW ━━━");
  const blocks = promptSrc.slice(start, end);
  assert.ok(!/\$\{/.test(blocks), "no template interpolation — the data arrives via {{variables}}");
});

// ── the chat prompt ──────────────────────────────────────────────────────────

const chatSrc = fs.readFileSync(require.resolve("../src/confirmation-agent/graph/prompt.js"), "utf8");

test("chat gets its own section, gated on the company having authored any", () => {
  assert.ok(/const PREVISIT_REQUIREMENTS = \(d\) =>/.test(chatSrc), "the block exists");
  assert.ok(/d\.previsitInstructions\.length > 0 && PREVISIT_REQUIREMENTS\(d\)/.test(chatSrc),
    "and is omitted entirely for a company with none");
});

test("chat reads the instructions resolved by the context, not a second lookup", () => {
  // job_type is a column on jobs, so one resolution per conversation is
  // correct. onsiteInstructions needs a per-appointment match because its key
  // (service_line) varies between a job's appointments; this does not.
  assert.ok(/previsitInstructions: Array\.isArray\(ctx\.previsit_instructions\)/.test(chatSrc),
    "taken from ctx, defensively");
});

test("the chat block marks which instructions must be waited on", () => {
  const block = chatSrc.slice(chatSrc.indexOf("const PREVISIT_REQUIREMENTS"), chatSrc.indexOf("const PREVISIT_REQUIREMENTS") + 2600);
  assert.ok(/requires_acknowledgement \? "ASK — wait for a clear yes" : "STATE"/.test(block),
    "per-instruction, the same ASK/STATE shape onsiteInstructions already uses");
  assert.ok(/never in the opening message/i.test(block), "timing is stated");
  assert.ok(/report_customer_intent/.test(block), "an answer is recorded for staff");
});
