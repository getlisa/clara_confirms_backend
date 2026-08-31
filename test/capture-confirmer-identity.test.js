/**
 * capture_confirmer_identity — records who is actually confirming for a chat
 * session, once, so every subsequent action/CRM comment can use a real name
 * instead of whoever the link happened to be addressed to. See actions.js's
 * captureConfirmerIdentityCore and confirmation-agent/index.js's
 * resolveConfirmedBy.
 *
 * phone is required, email is optional — product decision (people confirming
 * onsite work more reliably have a phone than an email on hand).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

const upsertCalls = [];
stub("db/confirmer-identities", {
  getByToken: async () => null,
  upsert: async (token, fields) => { upsertCalls.push({ token, fields }); },
});
// The rest of actions.js's own top-level requires — unused by this core
// function, but must not throw/hit a live DB just from being required.
stub("db/chat-links", { setStateByToken: async () => {}, markRemainingAddressed: async () => {} });
stub("services/job-confirmation-status", { syncJobConfirmationStatus: async () => "confirmed" });
stub("confirmation-agent/tools/service-link-helpers", { maybeSendServiceLinkNow: async () => ({ sent: false, reason: "no_recipient" }) });
stub("confirmation-agent/tools/confirmer-label", {
  resolveConfirmerLabel: async () => null,
  labelFromConfirmedBy: (confirmedBy) => (confirmedBy?.firstName ? [confirmedBy.firstName, confirmedBy.lastName].filter(Boolean).join(" ") : null),
});
stub("services/servicetrade-appointments", {
  mirrorRescheduleAppointment: async () => {}, mirrorCancelAppointment: async () => {},
  mirrorCancelJob: async () => {}, mirrorCreateAppointment: async () => {},
});
stub("db/todos", { create: async () => {} });
stub("utils/timezone", { getCompanyTimezone: async () => "America/Chicago", localToUTC: (s) => new Date(s + "Z").toISOString() });
stub("services/job-confirmation-context", { buildJobConfirmationContext: async () => ({ ok: false, error: "n/a" }) });
stub("db/confirmation-events", { recordSafe: async () => 1 });

const { captureConfirmerIdentityCore } = require("../src/confirmation-agent/actions");
const handler = require("../src/confirmation-agent/tools/handlers/capture-confirmer-identity");

function reset() {
  upsertCalls.length = 0;
}

// ── actions.js core ──────────────────────────────────────────────────────

test("captureConfirmerIdentityCore upserts the identity keyed by token", async () => {
  reset();
  const result = await captureConfirmerIdentityCore({
    threadId: "tok-1", firstName: "Jane", lastName: "Doe", role: "on_site", phone: "+15551234567", email: "jane@x.test",
  });
  assert.equal(result.success, true);
  assert.equal(result.first_name, "Jane");
  assert.equal(result.role, "on_site");
  assert.deepEqual(upsertCalls, [{
    token: "tok-1",
    fields: { firstName: "Jane", lastName: "Doe", role: "on_site", phone: "+15551234567", email: "jane@x.test" },
  }]);
});

test("captureConfirmerIdentityCore defaults a missing email to null, not undefined", async () => {
  reset();
  const result = await captureConfirmerIdentityCore({ threadId: "tok-2", firstName: "Jane", lastName: "Doe", role: "billing", phone: "+15551234567" });
  assert.equal(result.email, null);
  assert.equal(upsertCalls[0].fields.email, null);
});

test("captureConfirmerIdentityCore refuses to write with no active session (no threadId)", async () => {
  reset();
  const result = await captureConfirmerIdentityCore({ threadId: null, firstName: "Jane", lastName: "Doe", role: "on_site", phone: "+15551234567" });
  assert.equal(result.success, false);
  assert.equal(upsertCalls.length, 0, "no DB write should happen without a session to key it on");
});

// ── the LLM tool handler ─────────────────────────────────────────────────

test("the handler writes the model-supplied identity on a normal free-text turn", async () => {
  reset();
  const config = { configurable: { ctx: { threadId: "tok-3" } } };
  const out = JSON.parse(await handler.run(
    { first_name: "Jane", last_name: "Doe", role: "on_site", phone: "+15551234567", email: "jane@x.test" }, config
  ));
  assert.equal(out.success, true);
  assert.equal(upsertCalls[0].token, "tok-3");
  assert.equal(upsertCalls[0].fields.firstName, "Jane");
});

test("cardTriggerArgs wins over modelArgs — same precedence every other card-driven handler uses", async () => {
  reset();
  const config = {
    configurable: {
      ctx: {
        threadId: "tok-4",
        cardTriggerArgs: { first_name: "Real", last_name: "Name", role: "billing", phone: "+15559998888", email: null },
      },
    },
  };
  const out = JSON.parse(await handler.run(
    { first_name: "Hallucinated", last_name: "Model", role: "other", phone: "+15550000000" }, config
  ));
  assert.equal(out.first_name, "Real");
  assert.equal(out.role, "billing");
  assert.equal(upsertCalls[0].fields.phone, "+15559998888");
});

test("module exports the tool name/schema/description LangChain's tool() helper expects", () => {
  assert.equal(handler.name, "capture_confirmer_identity");
  assert.equal(typeof handler.run, "function");
  assert.ok(handler.description.length > 0);
  const parsed = handler.schema.parse({ first_name: "A", last_name: "B", role: "owner", phone: "+15551234567" });
  assert.equal(parsed.email, undefined, "email is genuinely optional in the schema");
  assert.throws(() => handler.schema.parse({ first_name: "A", last_name: "B", role: "not_a_real_role", phone: "+15551234567" }),
    "role must be one of the closed enum values");
  assert.throws(() => handler.schema.parse({ first_name: "A", last_name: "B", role: "owner" }),
    "phone is required in the schema");
});
