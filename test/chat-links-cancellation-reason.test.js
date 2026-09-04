/**
 * routes/chat-links.js's buildCardTriggerArgs — specifically the
 * cancellationReason relaxation added for InspectPoint (Phase 5). Full
 * routing-level coverage of "ServiceTrade requires it" already exists in
 * chat-cards-routes.test.js; this covers the `reasonRequired` parameter
 * itself, which that file's blanket db.query stub can't distinguish (it
 * always resolves every company to ServiceTrade).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [] }) });
stub("confirmation-agent", {});
stub("confirmation-agent/actions", { PROPOSE_REMAINING_TRIGGER: "propose_remaining_appointments" });
stub("services/chat-links", {});
stub("db/chat-links", {});
stub("db/chat-link-send-events", {});

const { buildCardTriggerArgs } = require("../src/routes/chat-links");

test("cancel_appointment: reasonRequired=true (default) rejects a missing reason", () => {
  const result = buildCardTriggerArgs("cancel_appointment", { appointment_id: 501 });
  assert.equal(result.ok, false);
  assert.match(result.error, /reason/i);
});

test("cancel_appointment: reasonRequired=true rejects a blank/whitespace-only reason", () => {
  const result = buildCardTriggerArgs("cancel_appointment", { appointment_id: 501, reason: "   " }, { reasonRequired: true });
  assert.equal(result.ok, false);
});

test("cancel_appointment: reasonRequired=false (InspectPoint) accepts a missing reason", () => {
  const result = buildCardTriggerArgs("cancel_appointment", { appointment_id: 501 }, { reasonRequired: false });
  assert.equal(result.ok, true);
  assert.equal(result.cardTriggerArgs.reason, null);
});

test("cancel_appointment: reasonRequired=false still carries through a REAL reason when the customer gives one", () => {
  const result = buildCardTriggerArgs("cancel_appointment", { appointment_id: 501, reason: "no longer needed" }, { reasonRequired: false });
  assert.equal(result.ok, true);
  assert.equal(result.cardTriggerArgs.reason, "no longer needed");
});

test("cancel_appointment: appointment_id is still required regardless of reasonRequired", () => {
  const result = buildCardTriggerArgs("cancel_appointment", { reason: "x" }, { reasonRequired: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /appointment_id/i);
});
