/**
 * routes/retell-tools.js — the voice-side Phase 6 additions:
 *   - POST /reschedule_appointment no longer hard-400s when scheduled_start
 *     is omitted (it used to) — it now raises the same staff-follow-up todo
 *     chat's reschedule_appointment tool already had, mirroring
 *     confirmation-agent/actions.js's raiseRescheduleRequest.
 *   - POST /reschedule_appointment returns 409 (not 500) on a slot conflict.
 *   - POST /propose_reschedule_slots — voice's equivalent of chat's
 *     propose_reschedule_slots tool.
 *
 * No supertest/HTTP server in this repo's test suite for this file — the
 * route handlers are invoked directly via Express Router introspection
 * (router.stack), with a minimal fake req/res, exactly the way this
 * codebase already unit-tests pure functions rather than standing up a
 * server. RETELL_TOOL_SECRET is cleared per test since verifyToolSecret
 * would otherwise reject an unauthenticated fake request.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [] }) });
stub("services/servicetrade-service-link", {});
stub("db/service-link-messages", {});
stub("db/scheduled-calls", {});
stub("db/service-opportunities", {});
stub("services/callback-time", {});
stub("services/job-confirmation-context", {});
stub("services/job-confirmation-status", { syncJobConfirmationStatus: async () => "confirmed" });
stub("db/confirmation-events", { recordSafe: async () => 1 });
stub("db/chat-links", { setState: async () => {} });
stub("services/retell-tools", { registerToolsForCompany: async () => {} });

let appointmentResult;
let updateAppointmentImpl;
stub("db/jobs", {
  getAppointmentById: async () => appointmentResult,
  updateAppointment: async (id, companyId, fields) => updateAppointmentImpl(id, companyId, fields),
});

const todoCalls = [];
stub("db/todos", {
  create: async (args) => { todoCalls.push(args); },
  TODO_TYPES: { ASKED_FOR_RESCHEDULE: "ASKED_FOR_RESCHEDULE" },
});

const consumeCalls = [];
const releaseCalls = [];
stub("db/slot-holds", {
  isSlotConflictError: (err) => err?.code === "23P01",
  consumeByWindow: async (args) => { consumeCalls.push(args); return null; },
  releaseAllForToken: async (args) => { releaseCalls.push(args); },
});

let offeredSlots;
const offerSlotsCalls = [];
stub("services/technician-availability", {
  offerSlots: async (args) => { offerSlotsCalls.push(args); return offeredSlots; },
});

stub("utils/timezone", {
  getCompanyTimezone: async () => "America/New_York",
  localToUTC: (s) => new Date(`${s.replace(/Z$/, "")}Z`).toISOString(),
  toOffsetISOString: (iso) => `${iso.slice(0, 19)}-04:00`,
  formatSpokenDate: (iso) => iso,
  formatSpokenDateTime: (iso) => `spoken(${iso})`,
  formatSpokenDateOnly: (d) => d,
});

const router = require("../src/routes/retell-tools");

function getHandler(path) {
  const layer = router.stack.find((l) => l.route?.path === path);
  if (!layer) throw new Error(`no route registered for ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeReq({ args = {}, companyId = 8, callId = "call-abc" } = {}) {
  return {
    query: {},
    headers: {},
    body: { args, call: { call_id: callId, metadata: { company_id: companyId } } },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function reset() {
  delete process.env.RETELL_TOOL_SECRET;
  logger.reset();
  todoCalls.length = 0;
  consumeCalls.length = 0;
  releaseCalls.length = 0;
  offerSlotsCalls.length = 0;
  offeredSlots = [{ starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T16:00:00.000Z" }];
  appointmentResult = { id: 501, job_id: 900, technician_id: 42, scheduled_start: "2026-08-10T14:00:00.000Z" };
  updateAppointmentImpl = async (id, _companyId, fields) => ({ id, job_id: 900, technician_id: 42, source: null, ...fields });
}

// ── /reschedule_appointment ─────────────────────────────────────────────────

test("reschedule_appointment: omitting scheduled_start no longer 400s — it escalates to a staff todo", async () => {
  reset();
  const handle = getHandler("/reschedule_appointment");
  const req = makeReq({ args: { appointment_id: "501" } });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.escalated, true);
  assert.equal(todoCalls.length, 1);
  assert.equal(todoCalls[0].type, "ASKED_FOR_RESCHEDULE");
  assert.equal(todoCalls[0].metadata.source, "voice_call");
  assert.equal(todoCalls[0].metadata.call_id, "call-abc");
  assert.equal(todoCalls[0].metadata.job_id, "900");
});

test("reschedule_appointment: still 400s when appointment_id itself is missing", async () => {
  reset();
  const handle = getHandler("/reschedule_appointment");
  const req = makeReq({ args: {} });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.statusCode, 400);
});

test("reschedule_appointment: a real scheduled_start still reschedules normally", async () => {
  reset();
  const handle = getHandler("/reschedule_appointment");
  const req = makeReq({ args: { appointment_id: "501", scheduled_start: "2026-09-01T14:00:00" } });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(todoCalls.length, 0);
});

test("reschedule_appointment: a 23P01 exclusion violation returns 409 with conflict:true, not a 500", async () => {
  reset();
  updateAppointmentImpl = async () => {
    const err = new Error("conflicting key value violates exclusion constraint");
    err.code = "23P01";
    throw err;
  };
  const handle = getHandler("/reschedule_appointment");
  const req = makeReq({ args: { appointment_id: "501", scheduled_start: "2026-09-01T14:00:00" } });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.success, false);
  assert.equal(res.body.conflict, true);
});

test("reschedule_appointment: any OTHER write error still 500s", async () => {
  reset();
  updateAppointmentImpl = async () => { throw new Error("connection lost"); };
  const handle = getHandler("/reschedule_appointment");
  const req = makeReq({ args: { appointment_id: "501", scheduled_start: "2026-09-01T14:00:00" } });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.statusCode, 500);
});

test("reschedule_appointment: on success, best-effort consumes the matching hold and releases the rest for this call", async () => {
  reset();
  const handle = getHandler("/reschedule_appointment");
  const req = makeReq({ args: { appointment_id: "501", scheduled_start: "2026-09-01T14:00:00" }, callId: "call-xyz" });
  const res = makeRes();
  await handle(req, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(consumeCalls.length, 1);
  assert.equal(consumeCalls[0].technicianId, 42);
  assert.equal(consumeCalls[0].heldByToken, "call-xyz");
  assert.equal(releaseCalls.length, 1);
});

// ── /propose_reschedule_slots ────────────────────────────────────────────────

test("propose_reschedule_slots: 400 when appointment_id is missing", async () => {
  reset();
  const handle = getHandler("/propose_reschedule_slots");
  const req = makeReq({ args: {} });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.statusCode, 400);
});

test("propose_reschedule_slots: 404 when the appointment doesn't exist", async () => {
  reset();
  appointmentResult = null;
  const handle = getHandler("/propose_reschedule_slots");
  const req = makeReq({ args: { appointment_id: "501" } });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.statusCode, 404);
});

test("propose_reschedule_slots: no technician assigned returns success:false without ever searching", async () => {
  reset();
  appointmentResult = { id: 501, job_id: 900, technician_id: null };
  const handle = getHandler("/propose_reschedule_slots");
  const req = makeReq({ args: { appointment_id: "501" } });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.body.success, false);
  assert.equal(offerSlotsCalls.length, 0);
});

test("propose_reschedule_slots: searches the assigned technician's calendar, tagged with the call id", async () => {
  reset();
  const handle = getHandler("/propose_reschedule_slots");
  const req = makeReq({ args: { appointment_id: "501" }, callId: "call-abc" });
  const res = makeRes();
  await handle(req, res);
  assert.equal(offerSlotsCalls.length, 1);
  assert.equal(offerSlotsCalls[0].technicianId, 42);
  assert.equal(offerSlotsCalls[0].heldByToken, "call-abc");
  assert.equal(offerSlotsCalls[0].excludeAppointmentId, 501);
});

test("propose_reschedule_slots: returns both a machine scheduled_start and a spoken form per slot", async () => {
  reset();
  const handle = getHandler("/propose_reschedule_slots");
  const req = makeReq({ args: { appointment_id: "501" } });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.body.success, true);
  assert.equal(res.body.slots[0].scheduled_start, "2026-06-01T14:00:00-04:00");
  assert.equal(res.body.slots[0].scheduled_start_spoken, "spoken(2026-06-01T14:00:00.000Z)");
});

test("propose_reschedule_slots: no open slots returns success:true with an explanatory message", async () => {
  reset();
  offeredSlots = [];
  const handle = getHandler("/propose_reschedule_slots");
  const req = makeReq({ args: { appointment_id: "501" } });
  const res = makeRes();
  await handle(req, res);
  assert.equal(res.body.success, true);
  assert.deepEqual(res.body.slots, []);
  assert.match(res.body.message, /no open times/i);
});
