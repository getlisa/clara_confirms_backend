/**
 * The chat agent must attempt the service-link send when it confirms.
 *
 * Two things have to be true before a service link can go out: the appointment
 * is confirmed, and a recipient has been captured. Whichever becomes true LAST
 * has to fire the send, otherwise the link silently never goes.
 *
 * The voice path has always done this from both of its confirm tools
 * (routes/retell-tools.js:213 and :315). Chat fired it only from the
 * recipient-capture step, so a customer who gave their email BEFORE confirming
 * got no link at all — the confirm that completed the preconditions never
 * looked. These tests pin the missing half.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
const logger = silentLogger();
stub("db", db);
stub("utils/logger", logger);

const sendCalls = [];
let sendImpl = async () => ({ sent: true });
stub("services/servicetrade-service-link", {
  sendRecordedServiceLink: async (args) => { sendCalls.push(args); return sendImpl(args); },
});

let recipientRow = { contact_id: 55, email: "dana@acme.test" };
stub("db/service-link-messages", { getByRetellCallId: async () => recipientRow });

const apptUpdates = [];
stub("db/jobs", {
  getAppointmentById: async (id) => ({ id, job_id: 900, customer_confirmed: false }),
  updateAppointment: async (id, _co, fields) => { apptUpdates.push({ id, fields }); return { id, job_id: 900 }; },
});
stub("db/chat-links", { setStateByToken: async () => {} });
stub("services/job-confirmation-status", { syncJobConfirmationStatus: async () => "confirmed" });

const confirmAppointment = require("../src/confirmation-agent/tools/handlers/confirm-appointment");

const CTX = { configurable: { ctx: { companyId: 9, threadId: "tok-1", jobRef: "77", recipientContactId: null } } };

function reset({ recipient = { contact_id: 55, email: "dana@acme.test" }, confirmedUpcoming = true } = {}) {
  db.reset(); logger.reset();
  sendCalls.length = 0; apptUpdates.length = 0;
  sendImpl = async () => ({ sent: true });
  recipientRow = recipient;
  // isJobUpcomingAppointmentConfirmed() runs this; one row = "yes, confirmed".
  db.on("FROM appointments a", confirmedUpcoming ? [{ ok: 1 }] : []);
  db.on("UPDATE appointments", []);
}

// ── The missing half ─────────────────────────────────────────────────────────

test("confirming sends the service link when a recipient was captured first", async () => {
  reset();
  const out = JSON.parse(await confirmAppointment.run({ appointment_id: 12 }, CTX));
  assert.equal(out.success, true);
  assert.equal(sendCalls.length, 1, "the confirm completed the preconditions, so it must fire the send");
  assert.equal(out.service_link_sent, true, "and report it, so the agent can say 'I've sent it'");
});

test("the appointment is still confirmed even if the link send fails", async () => {
  reset();
  sendImpl = async () => { throw new Error("servicetrade down"); };
  const out = JSON.parse(await confirmAppointment.run({ appointment_id: 12 }, CTX));
  assert.equal(out.success, true, "a link failure must never undo or block the confirmation");
  assert.equal(apptUpdates.length, 1);
  assert.equal(out.service_link_sent, false);
});

test("no recipient yet → no send, and the reason is reported not swallowed", async () => {
  reset({ recipient: null });
  const out = JSON.parse(await confirmAppointment.run({ appointment_id: 12 }, CTX));
  assert.equal(sendCalls.length, 0);
  assert.equal(out.service_link_sent, false);
  assert.equal(out.service_link_pending_reason, "no_recipient_yet",
    "the agent needs to know to ask for the email rather than claim it was sent");
});

test("a recipient row without an email does not count as captured", async () => {
  reset({ recipient: { contact_id: 55, email: null } });
  const out = JSON.parse(await confirmAppointment.run({ appointment_id: 12 }, CTX));
  assert.equal(sendCalls.length, 0);
  assert.equal(out.service_link_pending_reason, "no_recipient_yet");
});

test("an already-confirmed appointment stays a no-op and does not re-send", async () => {
  reset();
  const jobs = require("../src/db/jobs");
  const original = jobs.getAppointmentById;
  jobs.getAppointmentById = async (id) => ({ id, job_id: 900, customer_confirmed: true });
  try {
    const out = JSON.parse(await confirmAppointment.run({ appointment_id: 12 }, CTX));
    assert.equal(out.already_confirmed, true);
    assert.equal(apptUpdates.length, 0, "no re-stamping of customer_confirmed_at");
    assert.equal(sendCalls.length, 0, "and no duplicate link");
  } finally {
    jobs.getAppointmentById = original;
  }
});

test("the send is scoped to this conversation and this job", async () => {
  reset();
  await confirmAppointment.run({ appointment_id: 12 }, CTX);
  assert.equal(sendCalls[0].companyId, 9);
  assert.equal(sendCalls[0].retellCallId, "tok-1", "the chat token is the conversation key here");
});
