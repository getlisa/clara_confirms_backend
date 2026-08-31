/**
 * GET /chat-links/:token's initial load — the `appointments` field must
 * carry the FULL job appointment list, same as every card-trigger's `done`
 * event, not just one card. This used to be truncated to a single entry
 * (buildPrimaryAppointmentCard); the frontend now looks up appointment ids
 * referenced in OLDER transcript lines against whatever the widget has
 * loaded (chat-appointment-lookup-backend-request.md), which only works if
 * a customer reopening a link from an earlier session gets the whole list
 * up front, not just the one appointment the opening message is about.
 *
 * "Show only one card at a time" stays true — it's just enforced client-side
 * now (chat-cards-frontend.md §2), not by the backend shrinking the array.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [{ name: "Clara Fire", default_timezone: "America/Chicago", phone_number: null, representative_name: null }] }) });

let linkRow = { id: 1, token: "valid-token", company_id: 8, job_id: 900, appointment_id: null, call_type: "customer_confirmation", recipient_contact_id: null, recipient_name: null, recipient_email: null, recipient_phone: null, state: "chat_started", status: "sent" };
stub("db/chat-links", {
  getByToken: async (token) => (token === linkRow.token ? linkRow : null),
  markOpened: async () => {},
});

stub("services/call-hydration", {
  HYDRATORS: {
    job_confirmation: async () => ({
      ok: true,
      params: { customerName: "Acme", jobName: "Annual Inspection", jobDate: null },
      context: { ok: true, counts: { unconfirmed: 2 } },
    }),
  },
});

stub("confirmation-agent", {
  ensureOpened: async () => ({ messages: [], recipientName: null, recipientEmail: null, recipientPhone: null }),
});

let ctxResult = {
  ok: true,
  job: { id: 900, job_number: "1", title: "Annual Inspection", location_name: "Site" },
  appointments: {
    upcoming: [
      { appointment_id: 501, status: "scheduled", customer_confirmed: false, scheduled_start_spoken: "Thu" },
      { appointment_id: 502, status: "scheduled", customer_confirmed: false, scheduled_start_spoken: "Fri" },
      { appointment_id: 503, status: "scheduled", customer_confirmed: true, scheduled_start_spoken: "Sat" },
    ],
  },
  counts: { unconfirmed: 2, all_confirmed: false },
};
stub("services/job-confirmation-context", { buildJobConfirmationContext: async () => ctxResult });

stub("db/service-link-messages", { getByRetellCallId: async () => null });

const { resolveChatLink } = require("../src/services/chat-links");

function reset() {
  logger.reset();
  linkRow = { id: 1, token: "valid-token", company_id: 8, job_id: 900, appointment_id: null, call_type: "customer_confirmation", recipient_contact_id: null, recipient_name: null, recipient_email: null, recipient_phone: null, state: "chat_started", status: "sent" };
}

test("the initial load's appointments field carries every upcoming appointment on the job, not just one", async () => {
  reset();
  const result = await resolveChatLink("valid-token");
  assert.equal(result.ok, true);
  assert.equal(result.appointments.length, 3, "all three upcoming appointments must be present, not truncated to one");
  assert.deepEqual(result.appointments.map((a) => a.appointment_id), [501, 502, 503]);
});

test("the shape matches buildAppointmentCards exactly — same card fields as every trigger's done event", async () => {
  reset();
  const result = await resolveChatLink("valid-token");
  const card = result.appointments[0];
  assert.ok("status" in card && "actions_available" in card && "service_link" in card,
    "the initial load must use the same card-building function every other endpoint uses");
});

test("an empty upcoming list still returns an empty array, not an error", async () => {
  reset();
  ctxResult = { ...ctxResult, appointments: { upcoming: [] } };
  const result = await resolveChatLink("valid-token");
  assert.deepEqual(result.appointments, []);
});
