/**
 * propose_reschedule_slots (chat) — a thin wrapper over
 * services/technician-availability.js's offerSlots. Covers: no technician
 * assigned yet (nothing to search), the preferred_date -> search window
 * translation, and that returned slots carry BOTH a machine value that
 * round-trips into reschedule_appointment's own scheduled_start argument and
 * a spoken form for the agent to read aloud.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

let appointmentResult;
stub("db/jobs", { getAppointmentById: async () => appointmentResult });

let offeredSlots;
const offerSlotsCalls = [];
stub("services/technician-availability", {
  offerSlots: async (args) => { offerSlotsCalls.push(args); return offeredSlots; },
});

stub("utils/timezone", {
  getCompanyTimezone: async () => "America/New_York",
  localToUTC: (dateTimeStr) => new Date(dateTimeStr + "Z").toISOString(),
  toOffsetISOString: (iso) => `${iso.slice(0, 19)}-04:00`,
  formatSpokenDateTime: (iso) => `spoken(${iso})`,
});

const { run } = require("../src/confirmation-agent/tools/handlers/propose-reschedule-slots");

function reset() {
  appointmentResult = { id: 501, technician_id: 42 };
  offeredSlots = [{ starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T16:00:00.000Z" }];
  offerSlotsCalls.length = 0;
}

const CTX = { companyId: 7, threadId: "chat-thread-abc" };

test("appointment not found returns a clean failure, not a throw", async () => {
  reset();
  appointmentResult = null;
  const result = JSON.parse(await run({ appointment_id: 501 }, { configurable: { ctx: CTX } }));
  assert.equal(result.success, false);
  assert.match(result.error, /not found/i);
});

test("no technician assigned yet returns success:false with a clear reason, not an empty slot list", async () => {
  reset();
  appointmentResult = { id: 501, technician_id: null };
  const result = JSON.parse(await run({ appointment_id: 501 }, { configurable: { ctx: CTX } }));
  assert.equal(result.success, false);
  assert.match(result.error, /no technician/i);
  assert.equal(offerSlotsCalls.length, 0, "must not even attempt a search with no technician to search");
});

test("searches the assigned technician's calendar, excluding the appointment being rescheduled, tagged with threadId", async () => {
  reset();
  await run({ appointment_id: 501 }, { configurable: { ctx: CTX } });
  assert.equal(offerSlotsCalls.length, 1);
  assert.equal(offerSlotsCalls[0].companyId, 7);
  assert.equal(offerSlotsCalls[0].technicianId, 42);
  assert.equal(offerSlotsCalls[0].heldByToken, "chat-thread-abc");
  assert.equal(offerSlotsCalls[0].excludeAppointmentId, 501);
});

test("with no preferred_date, the search window starts now, not at a fixed date", async () => {
  reset();
  const before = Date.now();
  await run({ appointment_id: 501 }, { configurable: { ctx: CTX } });
  const windowStart = new Date(offerSlotsCalls[0].windowStart).getTime();
  assert.ok(windowStart >= before - 1000 && windowStart <= Date.now() + 1000);
});

test("preferred_date is converted to a UTC start-of-day window in the company's timezone", async () => {
  reset();
  await run({ appointment_id: 501, preferred_date: "2026-07-04" }, { configurable: { ctx: CTX } });
  assert.equal(offerSlotsCalls[0].windowStart, "2026-07-04T00:00:00.000Z");
});

test("the search window spans a two-week horizon from its start", async () => {
  reset();
  await run({ appointment_id: 501, preferred_date: "2026-07-04" }, { configurable: { ctx: CTX } });
  const spanDays = (new Date(offerSlotsCalls[0].windowEnd) - new Date(offerSlotsCalls[0].windowStart)) / 86_400_000;
  assert.equal(spanDays, 14);
});

test("no open slots returns success:true with an empty list and an explanatory message, not an error", async () => {
  reset();
  offeredSlots = [];
  const result = JSON.parse(await run({ appointment_id: 501 }, { configurable: { ctx: CTX } }));
  assert.equal(result.success, true);
  assert.deepEqual(result.slots, []);
  assert.match(result.message, /no open times/i);
});

test("each returned slot carries a machine scheduled_start AND a spoken form", async () => {
  reset();
  const result = JSON.parse(await run({ appointment_id: 501 }, { configurable: { ctx: CTX } }));
  assert.equal(result.success, true);
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].scheduled_start, "2026-06-01T14:00:00-04:00");
  assert.equal(result.slots[0].scheduled_start_spoken, "spoken(2026-06-01T14:00:00.000Z)");
});
