/**
 * The confirmation-events ledger (migration 097) — the daily report's only
 * source of "what actually got confirmed/rescheduled/cancelled, and when".
 *
 * Written from the FIVE chat tool handlers at the moment the DB write
 * succeeds — not from end_conversation's summary, so an outcome survives a
 * customer who confirms and then closes the tab; not from an "intent" signal
 * like report_customer_intent, for the same reason chat_links.state cannot be
 * trusted for this (it is set the instant the customer SAYS yes, before
 * anything reaches the CRM).
 *
 * The one behaviour every handler must have: a ledger failure must never fail
 * the actual confirmation/reschedule/cancel/create the customer asked for.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });
stub("db/chat-links", { setStateByToken: async () => {} });
stub("services/job-confirmation-status", { syncJobConfirmationStatus: async () => "confirmed" });
stub("confirmation-agent/tools/service-link-helpers", { maybeSendServiceLinkNow: async () => ({ sent: false, reason: "no_recipient" }) });
stub("confirmation-agent/tools/confirmer-label", { resolveConfirmerLabel: async () => null });
stub("services/servicetrade-appointments", {
  mirrorRescheduleAppointment: async () => {}, mirrorCancelAppointment: async () => {},
  mirrorCancelJob: async () => {}, mirrorCreateAppointment: async () => {},
});
stub("db/todos", { create: async () => {}, TODO_TYPES: { APPOINTMENT_CANCELLED: "APPOINTMENT_CANCELLED" } });
stub("utils/timezone", { getCompanyTimezone: async () => "America/Chicago", localToUTC: (s) => new Date(s + "Z").toISOString() });

const events = [];
let recordImpl = async (args) => { events.push(args); return 1; };
// Mirrors the REAL recordSafe's contract: never throws, logging never fails
// the write it describes. A test stub that skips this would make the
// "ledger failure doesn't break the outcome" tests below meaningless.
stub("db/confirmation-events", {
  recordSafe: async (args) => { try { return await recordImpl(args); } catch { return null; } },
});

const jobsDbCalls = { updateAppointment: [], getAppointmentById: [] };
let apptRow = { id: 501, job_id: 900, customer_confirmed: false, scheduled_start: "2026-08-10T14:00:00.000Z" };
stub("db/jobs", {
  getAppointmentById: async (id, companyId) => { jobsDbCalls.getAppointmentById.push({ id, companyId }); return apptRow; },
  updateAppointment: async (id, companyId, fields) => {
    jobsDbCalls.updateAppointment.push({ id, companyId, fields });
    return { ...apptRow, ...fields, id };
  },
  bulkConfirmAppointments: async () => {},
  createAppointment: async (companyId, jobId) => ({ id: 777, job_id: jobId }),
});

function reset() {
  events.length = 0;
  jobsDbCalls.updateAppointment.length = 0;
  jobsDbCalls.getAppointmentById.length = 0;
  apptRow = { id: 501, job_id: 900, customer_confirmed: false, scheduled_start: "2026-08-10T14:00:00.000Z" };
  recordImpl = async (args) => { events.push(args); return 1; };
  logger.reset();
}

const CTX = (extra = {}) => ({ configurable: { ctx: { companyId: 8, threadId: "tok-abc", jobRef: "77", recipientContactId: null, recipientName: "Shivam Koli", ...extra } } });

// ── confirm_appointment ──────────────────────────────────────────────────────

const confirmAppointment = require("../src/confirmation-agent/tools/handlers/confirm-appointment");

test("confirm_appointment logs a 'confirmed' event with the recipient's name", async () => {
  reset();
  const out = JSON.parse(await confirmAppointment.run({ appointment_id: 501 }, CTX()));
  assert.equal(out.success, true);
  assert.equal(events.length, 1);
  assert.match(events[0].eventType, /^confirmed$/);
  assert.equal(events[0].channel, "chat");
  assert.equal(events[0].callType, "customer_confirmation");
  assert.equal(events[0].jobId, 900);
  assert.equal(events[0].appointmentId, 501);
  assert.equal(events[0].actorName, "Shivam Koli");
  assert.equal(events[0].source, "tok-abc");
});

test("confirm_appointment logs NOTHING on the already-confirmed no-op path", async () => {
  reset();
  apptRow.customer_confirmed = true;
  const out = JSON.parse(await confirmAppointment.run({ appointment_id: 501 }, CTX()));
  assert.equal(out.already_confirmed, true);
  assert.equal(events.length, 0, "re-confirming an already-confirmed appointment is not a new outcome");
});

test("confirm_appointment: a ledger failure does not fail the confirmation", async () => {
  reset();
  recordImpl = async () => { throw new Error("ledger table gone"); };
  const out = JSON.parse(await confirmAppointment.run({ appointment_id: 501 }, CTX()));
  assert.equal(out.success, true, "the customer's confirmation must still succeed");
});

// ── confirm_job_appointments ─────────────────────────────────────────────────

stub("services/job-confirmation-context", {
  buildJobConfirmationContext: async () => ({
    ok: true,
    job: { id: 900, status: "scheduled" },
    appointments: { upcoming: [
      { appointment_id: 501, customer_confirmed: false },
      { appointment_id: 502, customer_confirmed: false },
    ] },
  }),
});
const confirmJobAppointments = require("../src/confirmation-agent/tools/handlers/confirm-job-appointments");

test("confirm_job_appointments logs ONE event per appointment, not one for the batch", async () => {
  reset();
  const out = JSON.parse(await confirmJobAppointments.run({ confirm_all: true }, CTX()));
  assert.equal(out.success, true);
  assert.equal(events.length, 2, "two appointments confirmed = two outcomes");
  assert.deepEqual(events.map((e) => e.appointmentId).sort(), [501, 502]);
  assert.ok(events.every((e) => e.eventType === "confirmed" && e.jobId === 900));
});

test("confirm_job_appointments logs nothing when there is nothing left to confirm", async () => {
  reset();
  const out = JSON.parse(await confirmJobAppointments.run({ appointment_ids: [999] }, CTX()));
  assert.equal(out.confirmed.length, 0);
  assert.equal(events.length, 0);
});

// ── reschedule_appointment ───────────────────────────────────────────────────

const rescheduleAppointment = require("../src/confirmation-agent/tools/handlers/reschedule-appointment");

test("reschedule_appointment logs the OLD and NEW time", async () => {
  reset();
  const out = JSON.parse(await rescheduleAppointment.run(
    { appointment_id: 501, scheduled_start: "2026-08-20T09:00:00" }, CTX()));
  assert.equal(out.success, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "rescheduled");
  assert.equal(events[0].details.from, "2026-08-10T14:00:00.000Z", "the time BEFORE the move, not after");
  assert.equal(events[0].details.to, out.scheduled_start);
});

test("reschedule_appointment: a ledger failure does not fail the reschedule", async () => {
  reset();
  recordImpl = async () => { throw new Error("boom"); };
  const out = JSON.parse(await rescheduleAppointment.run({ appointment_id: 501, scheduled_start: "2026-08-20T09:00:00" }, CTX()));
  assert.equal(out.success, true);
});

// ── cancel_appointment ───────────────────────────────────────────────────────

const cancelAppointment = require("../src/confirmation-agent/tools/handlers/cancel-appointment");

test("cancel_appointment logs the reason and scope", async () => {
  reset();
  const out = JSON.parse(await cancelAppointment.run(
    { appointment_id: 501, scope: "appointment_only", reason: "no longer needed" }, CTX()));
  assert.equal(out.success, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "cancelled");
  assert.deepEqual(events[0].details, { reason: "no longer needed", scope: "appointment_only" });
});

// ── create_appointment ───────────────────────────────────────────────────────

const createAppointment = require("../src/confirmation-agent/tools/handlers/create-appointment");

test("create_appointment logs a 'created' event", async () => {
  reset();
  const out = JSON.parse(await createAppointment.run(
    { scheduled_start: "2026-08-25T10:00:00" }, CTX({ jobId: 900 })));
  assert.equal(out.success, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "created");
  assert.equal(events[0].jobId, 900);
  assert.equal(events[0].appointmentId, 777);
});
