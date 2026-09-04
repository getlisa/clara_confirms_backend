/**
 * actions.js's rescheduleAppointmentCore — the slot-conflict handling added
 * alongside migrations/105_slot_holds.sql's appointments_inspectpoint_no_overlap
 * exclusion constraint (Phase 6). Two things this covers that
 * reschedule-appointment-optional-date.test.js doesn't:
 *   - a 23P01 exclusion violation from the write itself must become a normal
 *     {success:false, conflict:true} re-offer, never an uncaught 500;
 *   - a successful reschedule best-effort consumes the propose_reschedule_slots
 *     hold for this exact window/conversation and releases the rest.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [] }) });

let updateAppointmentImpl;
stub("db/jobs", {
  getAppointmentById: async (id) => ({ id, job_id: 900, scheduled_start: "2026-08-10T14:00:00.000Z" }),
  updateAppointment: async (id, companyId, fields) => updateAppointmentImpl(id, companyId, fields),
});

stub("db/chat-links", { setStateByToken: async () => {} });
stub("confirmation-agent/tools/confirmer-label", {
  resolveConfirmerLabel: async () => null,
  labelFromConfirmedBy: () => null,
});
stub("services/job-confirmation-status", { syncJobConfirmationStatus: async () => "confirmed" });
stub("db/confirmation-events", { recordSafe: async () => 1 });
stub("utils/timezone", {
  getCompanyTimezone: async () => "America/Chicago",
  localToUTC: (s) => new Date(`${s}Z`).toISOString(),
});

const consumeCalls = [];
const releaseCalls = [];
let consumeResolves = () => Promise.resolve(null);
stub("db/slot-holds", {
  isSlotConflictError: (err) => err?.code === "23P01",
  consumeByWindow: async (args) => { consumeCalls.push(args); return consumeResolves(); },
  releaseAllForToken: async (args) => { releaseCalls.push(args); },
});

const { rescheduleAppointmentCore } = require("../src/confirmation-agent/actions");

function reset() {
  logger.reset();
  consumeCalls.length = 0;
  releaseCalls.length = 0;
  consumeResolves = () => Promise.resolve(null);
  updateAppointmentImpl = async (id, _companyId, fields) => ({ id, job_id: 900, technician_id: 42, ...fields });
}

const ARGS = { companyId: 8, appointmentId: 501, threadId: "chat-thread-abc", scheduledStart: "2026-09-01T14:00:00" };

test("a 23P01 exclusion violation from the write becomes {success:false, conflict:true}, not a throw", async () => {
  reset();
  updateAppointmentImpl = async () => {
    const err = new Error("conflicting key value violates exclusion constraint");
    err.code = "23P01";
    throw err;
  };
  const result = await rescheduleAppointmentCore(ARGS);
  assert.equal(result.success, false);
  assert.equal(result.conflict, true);
  assert.match(result.error, /just booked/i);
});

test("any OTHER database error from the write propagates unchanged", async () => {
  reset();
  updateAppointmentImpl = async () => { throw new Error("connection lost"); };
  await assert.rejects(() => rescheduleAppointmentCore(ARGS), /connection lost/);
});

test("a successful reschedule best-effort consumes the hold for this exact technician/window/conversation", async () => {
  reset();
  await rescheduleAppointmentCore(ARGS);
  // Fire-and-forget cleanup — give its microtask a tick to run before asserting.
  await new Promise((r) => setImmediate(r));
  assert.equal(consumeCalls.length, 1);
  assert.equal(consumeCalls[0].companyId, 8);
  assert.equal(consumeCalls[0].technicianId, 42);
  assert.equal(consumeCalls[0].heldByToken, "chat-thread-abc");
});

test("once one hold is consumed, the rest of this conversation's holds are released", async () => {
  reset();
  consumeResolves = () => Promise.resolve({ id: 5 });
  await rescheduleAppointmentCore(ARGS);
  await new Promise((r) => setImmediate(r));
  assert.equal(releaseCalls.length, 1);
  assert.equal(releaseCalls[0].companyId, 8);
  assert.equal(releaseCalls[0].heldByToken, "chat-thread-abc");
});

test("no technician assigned or no threadId — hold cleanup is skipped entirely, not called with garbage", async () => {
  reset();
  updateAppointmentImpl = async (id, _companyId, fields) => ({ id, job_id: 900, technician_id: null, ...fields });
  await rescheduleAppointmentCore(ARGS);
  await new Promise((r) => setImmediate(r));
  assert.equal(consumeCalls.length, 0);
});
