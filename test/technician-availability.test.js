/**
 * services/technician-availability.js — Phase 6's channel-agnostic slot
 * finder. Chat's propose_reschedule_slots tool and voice's
 * POST /propose_reschedule_slots route both call this directly; this suite
 * exercises the availability math (busy appointments + live holds + company
 * dispatch hours) against a fake db, not either channel.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

let companyRow = { default_timezone: "America/New_York" };
let busyAppointments = [];
let activeHolds = [];
const heldCalls = [];

stub("db", {
  query: async (sql, params) => {
    if (/SELECT default_timezone FROM companies/.test(sql)) return { rows: [companyRow] };
    if (/SELECT scheduled_start, scheduled_end FROM appointments/.test(sql)) return { rows: busyAppointments };
    return { rows: [] };
  },
});

stub("db/call-settings", {
  getByCompanyId: async () => ({ business_hours_start: "09:00", business_hours_end: "17:00", include_weekends: false }),
});

stub("db/slot-holds", {
  listActive: async () => activeHolds,
  hold: async ({ startsAt, endsAt, technicianId, heldByToken }) => {
    heldCalls.push({ startsAt, endsAt, technicianId, heldByToken });
    return { ok: true, hold: { id: heldCalls.length, starts_at: startsAt, ends_at: endsAt } };
  },
});

const availability = require("../src/services/technician-availability");

function reset() {
  companyRow = { default_timezone: "America/New_York" };
  busyAppointments = [];
  activeHolds = [];
  heldCalls.length = 0;
}

// A Monday, fully inside 09:00-17:00 America/New_York, no DST edge cases.
const MONDAY_START = "2026-06-01T13:00:00.000Z"; // 09:00 America/New_York
const MONDAY_END = "2026-06-01T21:00:00.000Z"; // 17:00 America/New_York

test("returns the earliest open windows first, respecting business hours", async () => {
  reset();
  const slots = await availability.findAvailableSlots({
    companyId: 7, technicianId: 42, windowStart: MONDAY_START, windowEnd: MONDAY_END, maxResults: 2,
  });
  assert.equal(slots.length, 2);
  assert.equal(slots[0].starts_at, MONDAY_START);
  assert.equal(new Date(slots[1].starts_at).getTime() > new Date(slots[0].starts_at).getTime(), true);
});

test("skips a window that overlaps an existing appointment for that technician", async () => {
  reset();
  busyAppointments = [{ scheduled_start: MONDAY_START, scheduled_end: "2026-06-01T15:00:00.000Z" }];
  const slots = await availability.findAvailableSlots({
    companyId: 7, technicianId: 42, windowStart: MONDAY_START, windowEnd: MONDAY_END, maxResults: 1,
  });
  assert.equal(slots.length, 1);
  assert.equal(new Date(slots[0].starts_at).getTime() >= new Date("2026-06-01T15:00:00.000Z").getTime(), true);
});

test("a cancelled appointment is excluded from the busy-window query itself", async () => {
  reset();
  await availability.findAvailableSlots({ companyId: 7, technicianId: 42, windowStart: MONDAY_START, windowEnd: MONDAY_END });
  // Verified structurally: the fake db always returns busyAppointments regardless
  // of status, so this test documents the query's own filter via its SQL shape.
  const db = require("../src/db");
  let capturedSql = null;
  const orig = db.query;
  db.query = async (sql, params) => { if (/appointments/.test(sql)) capturedSql = sql; return orig(sql, params); };
  await availability.findAvailableSlots({ companyId: 7, technicianId: 42, windowStart: MONDAY_START, windowEnd: MONDAY_END });
  db.query = orig;
  assert.match(capturedSql, /status <> 'cancelled'/);
});

test("excludeAppointmentId omits that appointment's own row from the busy check (rescheduling itself)", async () => {
  reset();
  const db = require("../src/db");
  let capturedParams = null;
  const orig = db.query;
  db.query = async (sql, params) => { if (/appointments/.test(sql)) capturedParams = params; return orig(sql, params); };
  await availability.findAvailableSlots({ companyId: 7, technicianId: 42, windowStart: MONDAY_START, windowEnd: MONDAY_END, excludeAppointmentId: 999 });
  db.query = orig;
  assert.deepEqual(capturedParams, [7, 42, MONDAY_START, MONDAY_END, 999]);
});

test("a slot held by another conversation is treated as busy", async () => {
  reset();
  activeHolds = [{ starts_at: MONDAY_START, ends_at: "2026-06-01T15:00:00.000Z" }];
  const slots = await availability.findAvailableSlots({
    companyId: 7, technicianId: 42, windowStart: MONDAY_START, windowEnd: MONDAY_END, maxResults: 1,
  });
  assert.equal(new Date(slots[0].starts_at).getTime() >= new Date("2026-06-01T15:00:00.000Z").getTime(), true);
});

test("never proposes a window that would end after business hours close", async () => {
  reset();
  // Only ~1 hour of daylight left before close (16:00-17:00 ET) — no 2-hour slot fits.
  const slots = await availability.findAvailableSlots({
    companyId: 7, technicianId: 42, windowStart: "2026-06-01T20:00:00.000Z", windowEnd: MONDAY_END,
  });
  assert.deepEqual(slots, []);
});

test("missing companyId/technicianId/window returns an empty array rather than throwing", async () => {
  reset();
  assert.deepEqual(await availability.findAvailableSlots({}), []);
});

test("offerSlots places a hold on every candidate it returns, tagged with heldByToken", async () => {
  reset();
  const slots = await availability.offerSlots({
    companyId: 7, technicianId: 42, heldByToken: "chat-thread-abc", windowStart: MONDAY_START, windowEnd: MONDAY_END, maxResults: 2,
  });
  assert.equal(slots.length, 2);
  assert.equal(heldCalls.length, 2);
  assert.equal(heldCalls.every((c) => c.heldByToken === "chat-thread-abc" && c.technicianId === 42), true);
});

test("offerSlots drops (not errors on) a candidate that loses the hold race", async () => {
  reset();
  const slotHoldsDb = require("../src/db/slot-holds");
  const orig = slotHoldsDb.hold;
  let call = 0;
  slotHoldsDb.hold = async (args) => {
    call++;
    if (call === 1) return { ok: false, conflict: true };
    return orig(args);
  };
  const slots = await availability.offerSlots({
    companyId: 7, technicianId: 42, heldByToken: "tok", windowStart: MONDAY_START, windowEnd: MONDAY_END, maxResults: 2,
  });
  slotHoldsDb.hold = orig;
  assert.equal(slots.length, 1);
});
