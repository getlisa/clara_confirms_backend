/**
 * "Send the entire context pre-call" — the CONTRACT between the three places
 * that have to agree about a dynamic variable:
 *
 *   1. src/services/scheduler.js        binds it at dispatch (sometimes)
 *   2. src/db/call-type-configs.js      references it as {{name}} in the prompt
 *   3. src/db/dynamic-variable-definitions.js  registers it in the catalog
 *
 * (3) is not bookkeeping. `retell-flow.syncFlowForCompany` builds the flow's
 * `default_dynamic_variables` from that catalog, and it is the ONLY thing that
 * gives an unbound variable an empty-string default. A {{name}} that is
 * referenced in a prompt but absent from the catalog renders as the literal
 * text "{{name}}" whenever the dispatcher doesn't set it — spoken aloud to the
 * customer. Pre-binding made this reachable: every new variable is conditional
 * on there being a next appointment / an email on file.
 */

process.env.LOG_LEVEL = "error";

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
const { createFakeDb } = require("./helpers/fake-db");

stub("db/index.js", createFakeDb());
stub("utils/logger.js", silentLogger());

const { VARIABLE_SEEDS } = require("../src/db/dynamic-variable-definitions");
const { BUILTIN_TYPES, generateDefaultPrompts } = require("../src/db/call-type-configs");

const REGISTERED = new Set(VARIABLE_SEEDS.map((v) => v.name));

function placeholdersIn(text) {
  return new Set([...String(text || "").matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]));
}

function promptsFor(type) {
  const p = generateDefaultPrompts(type, type, "") || {};
  return [p.begin_message, p.general_prompt].filter(Boolean).join("\n");
}

// The six variables the change added, per its own stated guardrail: "registered
// so they default to empty string; unregistered, the fallback path would speak
// a literal {{upcoming_count}} aloud."
const PRE_BOUND = [
  "upcoming_count",
  "unconfirmed_count",
  "all_upcoming_confirmed",
  "next_appointment_id",
  "next_technician",
  "upcoming_appointments",
  "next_service_line",
  "next_appointment_date",
];

test("every pre-bound appointment variable is registered in the catalog", () => {
  const missing = PRE_BOUND.filter((n) => !REGISTERED.has(n));
  assert.deepEqual(missing, [], `unregistered pre-bound variables get no "" default and render literally: ${missing.join(", ")}`);
});

test("every {{placeholder}} in the customer_confirmation prompt is registered", () => {
  const used = placeholdersIn(promptsFor("customer_confirmation"));
  const missing = [...used].filter((n) => !REGISTERED.has(n));
  assert.deepEqual(missing, [], `referenced but never registered: ${missing.join(", ")}`);
});

test("every {{placeholder}} in every built-in call type's prompt is registered", () => {
  const missing = new Map();
  for (const type of BUILTIN_TYPES.map((t) => t.type ?? t)) {
    for (const name of placeholdersIn(promptsFor(type))) {
      if (!REGISTERED.has(name)) {
        if (!missing.has(name)) missing.set(name, []);
        missing.get(name).push(type);
      }
    }
  }
  assert.deepEqual([...missing.keys()], [], `unregistered: ${[...missing].map(([n, t]) => `${n} (${t.join(",")})`).join("; ")}`);
});

test("the opening line's variables are the ones most exposed to a literal render", () => {
  // begin_message is the very first thing spoken, before any tool call or any
  // conditional prompt logic can save it. Anything referenced there MUST have
  // a catalog default.
  const { begin_message } = generateDefaultPrompts("customer_confirmation", "customer_confirmation", "");
  const used = [...placeholdersIn(begin_message)];
  assert.ok(used.length > 0);
  const missing = used.filter((n) => !REGISTERED.has(n));
  assert.deepEqual(missing, [], `spoken literally on a job with no upcoming appointment: ${missing.join(", ")}`);
});

// ── The two guardrails the change relies on ──────────────────────────────────
// Pre-bound values are a call-start snapshot. That is only safe because the
// prompt carries two explicit rules. If either is edited away, the agent starts
// quoting stale counts after a write, or speaks about appointments it was never
// given. Neither failure is visible in the dispatcher's output.

test("the prompt tells the agent the pre-bound values go stale after any write", () => {
  const { general_prompt } = generateDefaultPrompts("customer_confirmation", "customer_confirmation", "");

  assert.match(general_prompt, /THEY DO NOT UPDATE DURING THE CALL/);
  assert.match(general_prompt, /confirm, reschedule, cancel or create[\s\S]{0,120}get_appointments/);
});

test("the prompt tells the agent to fall back to the tool when the values are blank", () => {
  const { general_prompt } = generateDefaultPrompts("customer_confirmation", "customer_confirmation", "");

  assert.match(general_prompt, /IF \{\{upcoming_count\}\} IS BLANK/);
  assert.match(general_prompt, /call get_appointments with job_id=\{\{job_id\}\}/);
});

test("the prompt no longer stalls the opening on a tool round-trip", () => {
  const { begin_message, general_prompt } = generateDefaultPrompts("customer_confirmation", "customer_confirmation", "");

  // The whole point of the change: STEP 1 must not open with a tool call.
  assert.match(general_prompt, /Do NOT call get_appointments here/);
  assert.ok(!/STEP 1 — Call get_appointments/.test(general_prompt));
  // ...and the opening line itself carries the real service and date.
  assert.match(begin_message, /\{\{next_service_line\}\}/);
  assert.match(begin_message, /\{\{next_appointment_date\}\}/);
});

test("the prompt tells the agent what to do when the capped list is truncated", () => {
  const { general_prompt } = generateDefaultPrompts("customer_confirmation", "customer_confirmation", "");
  assert.match(general_prompt, /plus N more[\s\S]{0,120}get_appointments/);
});

test("the catalog itself is well-formed (no duplicate names or sort orders)", () => {
  const names = VARIABLE_SEEDS.map((v) => v.name);
  assert.equal(new Set(names).size, names.length, "duplicate variable name — the last seed silently wins");

  const orders = VARIABLE_SEEDS.map((v) => v.sort_order);
  assert.equal(new Set(orders).size, orders.length, "duplicate sort_order — catalog ordering is non-deterministic");

  for (const v of VARIABLE_SEEDS) {
    assert.ok(v.description && v.description.length > 10, `${v.name} needs a description — it's the UI's only explanation`);
    assert.ok(v.resolved_from, `${v.name} needs resolved_from — it's how you find the code that fills it`);
  }
});

test("the catalog documents the appointment variables as dispatch-time, not queue-time", () => {
  // The change reversed a documented rule ("appointment data is deliberately
  // not injected"). If someone re-adds a variable sourced from the queued row
  // rather than from live dispatch, the staleness bug comes straight back.
  for (const name of ["upcoming_count", "unconfirmed_count", "all_upcoming_confirmed",
                      "next_appointment_id", "next_technician", "upcoming_appointments"]) {
    const seed = VARIABLE_SEEDS.find((v) => v.name === name);
    if (!seed) continue; // covered by the registration test above
    assert.match(seed.resolved_from, /live at dispatch/, `${name} must be documented as computed live at dispatch`);
  }
});
