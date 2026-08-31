/**
 * reschedule_appointment's optional scheduled_start — omitting it is the
 * "customer declined to pick a time" skip path. This used to be a
 * route-level branch (routes/chat-links.js calling actions.js's
 * raiseRescheduleRequest directly, no agent turn at all); it now lives
 * INSIDE the tool handler itself, so the exact same trigger/tool handles
 * both branches uniformly through POST /:token/messages (chat-cards-frontend.md
 * §3/§6) instead of a separate no-SSE code path.
 *
 * The handler deliberately does NOT use the usual
 * `{...modelArgs, ...cardTriggerArgs}` merge for scheduled_start/
 * scheduled_end on a card-driven turn — see the handler's own comment for
 * why a model-hallucinated date must never leak through when cardTriggerArgs
 * omitted one on purpose.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [] }) });

const todoCalls = [];
stub("db/todos", {
  create: async (args) => { todoCalls.push(args); },
  TODO_TYPES: { ASKED_FOR_RESCHEDULE: "ASKED_FOR_RESCHEDULE" },
});

stub("db/jobs", {
  getAppointmentById: async (id) => ({ id, job_id: 900, scheduled_start: "2026-08-10T14:00:00.000Z" }),
  updateAppointment: async (id, _companyId, fields) => ({ id, job_id: 900, ...fields }),
});

const stateCalls = [];
stub("db/chat-links", { setStateByToken: async (token, state) => { stateCalls.push({ token, state }); } });

stub("confirmation-agent/tools/confirmer-label", {
  resolveConfirmerLabel: async () => null,
  labelFromConfirmedBy: (confirmedBy) => (confirmedBy?.firstName ? [confirmedBy.firstName, confirmedBy.lastName].filter(Boolean).join(" ") : null),
});
stub("services/job-confirmation-status", { syncJobConfirmationStatus: async () => "confirmed" });
stub("services/servicetrade-appointments", { mirrorRescheduleAppointment: async () => {} });
stub("db/confirmation-events", { recordSafe: async () => 1 });
stub("utils/timezone", {
  getCompanyTimezone: async () => "America/Chicago",
  localToUTC: (s) => new Date(`${s}Z`).toISOString(),
});

const rescheduleAppointment = require("../src/confirmation-agent/tools/handlers/reschedule-appointment");

function reset() {
  todoCalls.length = 0;
  stateCalls.length = 0;
  logger.reset();
}

const CTX = (extra = {}) => ({ configurable: { ctx: { companyId: 8, jobId: 900, threadId: "tok-1", recipientName: "Dana", ...extra } } });

test("schema allows scheduled_start to be omitted", () => {
  const result = rescheduleAppointment.schema.safeParse({ appointment_id: 501 });
  assert.equal(result.success, true);
});

test("omitting scheduled_start raises a staff todo instead of moving the appointment", async () => {
  reset();
  const out = JSON.parse(await rescheduleAppointment.run({ appointment_id: 501 }, CTX()));
  assert.equal(out.success, true);
  assert.equal(out.escalated, true);
  assert.equal(out.appointment_id, 501);
  assert.equal(out.message, "Our team will follow up to find a time.");
  assert.equal(todoCalls.length, 1);
  assert.equal(todoCalls[0].type, "ASKED_FOR_RESCHEDULE");
  assert.equal(todoCalls[0].companyId, 8);
  assert.equal(todoCalls[0].metadata.job_id, "900");
  assert.equal(todoCalls[0].metadata.appointment_id, "501");
  assert.equal(stateCalls[0].state, "reschedule_needed");
});

test("a card trigger with no scheduled_start escalates even if the model's own args hallucinated a date", async () => {
  reset();
  const out = JSON.parse(await rescheduleAppointment.run(
    { appointment_id: 999, scheduled_start: "2026-09-01T14:00:00" },
    CTX({ cardTriggerArgs: { appointment_id: 501 } })
  ));
  assert.equal(out.escalated, true, "cardTriggerArgs omitting scheduled_start must win, not the model's own value");
  assert.equal(out.appointment_id, 501, "cardTriggerArgs.appointment_id wins over modelArgs too");
});

test("a card trigger WITH a real scheduled_start still reschedules for real", async () => {
  reset();
  const out = JSON.parse(await rescheduleAppointment.run(
    {},
    CTX({ cardTriggerArgs: { appointment_id: 501, scheduled_start: "2026-09-01T14:00:00" } })
  ));
  assert.equal(out.success, true);
  assert.equal(out.escalated, undefined);
  assert.ok(out.scheduled_start);
  assert.equal(todoCalls.length, 0, "must not also raise a staff todo when a real reschedule happened");
});
