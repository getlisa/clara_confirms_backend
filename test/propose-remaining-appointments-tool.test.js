/**
 * propose_remaining_appointments — the agent's own proactive "confirm the
 * rest?" tool call. Unlike the other card-route tools, this one is NOT a
 * thin wrapper over an actions.js core function with no logic of its own:
 * appointment_ids come straight from the model, so the handler must
 * cross-check them against the real still-unconfirmed list rather than
 * trust them blindly — a hallucinated id here would otherwise silently
 * mis-render a card for an appointment that isn't actually pending.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

let ctxResult;
stub("services/job-confirmation-context", { buildJobConfirmationContext: async () => ctxResult });

const { run } = require("../src/confirmation-agent/tools/handlers/propose-remaining-appointments");

const JOB = { job_number: "1", title: "J", location_name: "Site" };
function appt(overrides = {}) {
  return {
    appointment_id: 501, status: "scheduled", customer_confirmed: false,
    scheduled_start_spoken: "Thursday", arrival_window_spoken: null,
    service_line: "Inspection", service_details: [], technicians: [],
    ...overrides,
  };
}

function reset() {
  ctxResult = {
    ok: true, job: JOB,
    appointments: { upcoming: [appt({ appointment_id: 501 }), appt({ appointment_id: 502 }), appt({ appointment_id: 503, customer_confirmed: true })] },
  };
}

test("returns the message verbatim and real cards for the requested ids", async () => {
  reset();
  const out = JSON.parse(await run({ message: "Want to confirm those too?", appointment_ids: [501, 502] }, { configurable: { ctx: { companyId: 8, jobId: 900 } } }));
  assert.equal(out.success, true);
  assert.equal(out.message, "Want to confirm those too?");
  assert.deepEqual(out.appointments.map((a) => a.appointment_id), [501, 502]);
});

test("filters out a hallucinated id that isn't a real appointment on this job", async () => {
  reset();
  const out = JSON.parse(await run({ message: "m", appointment_ids: [501, 999999] }, { configurable: { ctx: { companyId: 8, jobId: 900 } } }));
  assert.deepEqual(out.appointments.map((a) => a.appointment_id), [501]);
});

test("filters out an id that's already confirmed — not_confirmed only", async () => {
  reset();
  const out = JSON.parse(await run({ message: "m", appointment_ids: [501, 503] }, { configurable: { ctx: { companyId: 8, jobId: 900 } } }));
  assert.deepEqual(out.appointments.map((a) => a.appointment_id), [501]);
});

test("string and number ids both match the same appointment", async () => {
  reset();
  const out = JSON.parse(await run({ message: "m", appointment_ids: ["501"] }, { configurable: { ctx: { companyId: 8, jobId: 900 } } }));
  assert.deepEqual(out.appointments.map((a) => a.appointment_id), [501]);
});

test("degrades to a clean failure when the job context can't be built", async () => {
  ctxResult = { ok: false, error: "Job not found" };
  const out = JSON.parse(await run({ message: "m", appointment_ids: [501] }, { configurable: { ctx: { companyId: 8, jobId: 900 } } }));
  assert.equal(out.success, false);
  assert.equal(out.error, "Job not found");
});
