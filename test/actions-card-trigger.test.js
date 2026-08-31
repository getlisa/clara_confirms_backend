/**
 * actions.js's CARD_TRIGGER_PREFIX/buildCardTrigger/parseCardTrigger — the
 * marker a card-driven action route sends through the agent (graph/build.js
 * parses it to decide which single tool to force this turn). No args are
 * embedded in the marker itself (those travel via ctx.cardTriggerArgs) —
 * this only carries the tool name, so keeping the round trip exact matters:
 * a mismatch here would either leak a raw marker into the visible
 * transcript (parseCardTrigger too strict) or bind the wrong tool (too loose).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [] }) });

const { buildCardTrigger, parseCardTrigger, CARD_TRIGGER_PREFIX } = require("../src/confirmation-agent/actions");

test("buildCardTrigger/parseCardTrigger round-trip for every promoted tool name", () => {
  for (const tool of ["confirm_appointment", "reschedule_appointment", "cancel_appointment", "confirm_job_appointments", "decline_remaining_appointments"]) {
    const marker = buildCardTrigger(tool);
    assert.ok(marker.startsWith(CARD_TRIGGER_PREFIX));
    assert.equal(parseCardTrigger(marker), tool);
  }
});

test("parseCardTrigger returns null for a normal customer message", () => {
  assert.equal(parseCardTrigger("yes, please confirm it"), null);
});

test("parseCardTrigger returns null for non-string input", () => {
  assert.equal(parseCardTrigger(undefined), null);
  assert.equal(parseCardTrigger(null), null);
  assert.equal(parseCardTrigger(42), null);
});

test("parseCardTrigger returns null for the bare prefix with no tool name", () => {
  assert.equal(parseCardTrigger(CARD_TRIGGER_PREFIX), null);
});

test("parseCardTrigger does not match a message that merely CONTAINS the prefix mid-string", () => {
  assert.equal(parseCardTrigger(`please ${CARD_TRIGGER_PREFIX}confirm_appointment`), null);
});
