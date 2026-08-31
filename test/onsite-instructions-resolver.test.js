/**
 * resolveOnsiteInstructions — the deterministic (not soft-LLM-matched) rule
 * behind the new onsite_instructions table: general rows always apply,
 * service-line rows only when they exactly match. See migrations/101 and
 * graph/prompt.js's ONSITE_EXPECTATIONS / appointment-card.js.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveOnsiteInstructions } = require("../src/services/onsite-instructions-resolver");

test("an empty/missing list resolves to an empty array", () => {
  assert.deepEqual(resolveOnsiteInstructions([], "Fire Alarm"), []);
  assert.deepEqual(resolveOnsiteInstructions(null, "Fire Alarm"), []);
  assert.deepEqual(resolveOnsiteInstructions(undefined, null), []);
});

test("a general row (service_line: null) matches every service line, including null", () => {
  const all = [{ service_line: null, instruction: "General", requires_response: false }];
  assert.equal(resolveOnsiteInstructions(all, "Fire Alarm").length, 1);
  assert.equal(resolveOnsiteInstructions(all, "Backflow").length, 1);
  assert.equal(resolveOnsiteInstructions(all, null).length, 1);
});

test("a specific row matches ONLY its own exact service_line — no soft/partial matching", () => {
  const all = [{ service_line: "Fire Alarm", instruction: "Alarm-specific", requires_response: false }];
  assert.equal(resolveOnsiteInstructions(all, "Fire Alarm").length, 1);
  assert.equal(resolveOnsiteInstructions(all, "Fire Alarm Inspection").length, 0,
    "an exact match is required — a similar-looking service line must NOT match");
  assert.equal(resolveOnsiteInstructions(all, "Backflow").length, 0);
  assert.equal(resolveOnsiteInstructions(all, null).length, 0);
});

test("general and specific rows combine — general always included, specific layered on top", () => {
  const all = [
    { service_line: null, instruction: "General", requires_response: false },
    { service_line: "Fire Alarm", instruction: "Alarm-specific", requires_response: true },
    { service_line: "Backflow", instruction: "Backflow-specific", requires_response: false },
  ];
  const result = resolveOnsiteInstructions(all, "Fire Alarm");
  assert.equal(result.length, 2);
  assert.deepEqual(result.map((r) => r.instruction), ["General", "Alarm-specific"]);
});

test("preserves row order (id order from the DB query) rather than re-sorting", () => {
  const all = [
    { service_line: "Fire Alarm", instruction: "First", requires_response: false },
    { service_line: null, instruction: "Second", requires_response: false },
  ];
  const result = resolveOnsiteInstructions(all, "Fire Alarm");
  assert.deepEqual(result.map((r) => r.instruction), ["First", "Second"]);
});
