/**
 * The appointment card contract — the structural gate the whole feature's
 * determinism claim rests on. Same philosophy as registry.js's PHASE_TOOLS:
 * the backend tells the UI exactly which buttons apply, computed from real
 * state, so the frontend never re-derives (and potentially gets wrong)
 * business rules like "don't offer Confirm on an already-confirmed visit."
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildAppointmentCard, buildAppointmentCards } = require("../src/confirmation-agent/appointment-card");

function appt(overrides = {}) {
  return {
    appointment_id: 501,
    status: "scheduled",
    customer_confirmed: false,
    scheduled_start: "2026-08-20T18:00:00.000Z",
    scheduled_start_spoken: "Thursday, August 20, 2026 at 2:00 PM",
    arrival_window_spoken: "between 2 PM and 3 PM",
    service_line: "Fire Alarm Inspection",
    service_details: [{ service_line: "Fire Alarm Inspection", description: "Semi-annual test" }],
    technicians: [{ name: "Casey Nary", phone: "+15550001111", email: null }],
    ...overrides,
  };
}
const JOB = { job_number: "49354684", title: "Inspection Job #49354684", location_name: "Kings Theatre" };

test("a not-yet-confirmed appointment offers all three actions", () => {
  const card = buildAppointmentCard(appt(), JOB);
  assert.equal(card.status, "not_confirmed");
  assert.deepEqual(card.actions_available, ["confirm", "reschedule", "cancel"]);
});

test("a confirmed appointment offers reschedule/cancel but NOT confirm again", () => {
  const card = buildAppointmentCard(appt({ customer_confirmed: true }), JOB);
  assert.equal(card.status, "confirmed");
  assert.deepEqual(card.actions_available, ["reschedule", "cancel"]);
  assert.ok(!card.actions_available.includes("confirm"),
    "a second confirm on an already-confirmed card must be structurally impossible, not just discouraged");
});

test("a cancelled appointment offers nothing — there is nothing left to do", () => {
  const card = buildAppointmentCard(appt({ status: "cancelled", customer_confirmed: false }), JOB);
  assert.equal(card.status, "cancelled");
  assert.deepEqual(card.actions_available, []);
});

test("cancelled status wins even if customer_confirmed was true before the cancel", () => {
  // A confirmed appointment that gets cancelled must not render as "confirmed"
  // just because the flag was never cleared.
  const card = buildAppointmentCard(appt({ status: "cancelled", customer_confirmed: true }), JOB);
  assert.equal(card.status, "cancelled");
  assert.deepEqual(card.actions_available, []);
});

test("job_number/job_title/location_name are merged in from the JOB, not the appointment", () => {
  const card = buildAppointmentCard(appt(), JOB);
  assert.equal(card.job_number, "49354684");
  assert.equal(card.job_title, "Inspection Job #49354684");
  assert.equal(card.location_name, "Kings Theatre");
});

test("arrival_window_label carries the exact spoken window — the field the UI renders in italic", () => {
  const card = buildAppointmentCard(appt(), JOB);
  assert.equal(card.arrival_window_label, "between 2 PM and 3 PM");
});

test("a null arrival window (DST edge case) stays null, never a fabricated string", () => {
  const card = buildAppointmentCard(appt({ arrival_window_spoken: null }), JOB);
  assert.equal(card.arrival_window_label, null);
});

test("service_requests carries EVERY service, line + description paired", () => {
  const card = buildAppointmentCard(appt({
    service_details: [
      { service_line: "Fire Alarm Inspection", description: "Semi-annual test" },
      { service_line: "Sprinkler Inspection", description: null },
    ],
  }), JOB);
  assert.deepEqual(card.service_requests, [
    { line: "Fire Alarm Inspection", description: "Semi-annual test" },
    { line: "Sprinkler Inspection", description: null },
  ]);
});

test("technicians carries the full crew, not just the lead", () => {
  const card = buildAppointmentCard(appt({
    technicians: [{ name: "Casey Nary", phone: "+1555", email: null }, { name: "Alex Pearson", phone: null, email: "a@x.test" }],
  }), JOB);
  assert.equal(card.technicians.length, 2);
  assert.deepEqual(card.technicians[1], { name: "Alex Pearson", phone: null, email: "a@x.test" });
});

test("missing job/technicians/service_details degrade to empty, never throw", () => {
  const card = buildAppointmentCard({ appointment_id: 1, status: "scheduled", customer_confirmed: false }, null);
  assert.equal(card.job_number, null);
  assert.deepEqual(card.service_requests, []);
  assert.deepEqual(card.technicians, []);
});

test("buildAppointmentCards maps every upcoming appointment on the job context", () => {
  const ctx = { ok: true, job: JOB, appointments: { upcoming: [appt({ appointment_id: 1 }), appt({ appointment_id: 2, customer_confirmed: true })] } };
  const cards = buildAppointmentCards(ctx);
  assert.equal(cards.length, 2);
  assert.deepEqual(cards.map((c) => c.appointment_id), [1, 2]);
  assert.deepEqual(cards.map((c) => c.status), ["not_confirmed", "confirmed"]);
});

test("buildAppointmentCards degrades to an empty array for a not-ok context", () => {
  assert.deepEqual(buildAppointmentCards({ ok: false, error: "Job not found" }), []);
});

// ── service_link — job-scoped, echoed identically onto every card ──────────

test("with no serviceLink argument, every card defaults to not sent / no url", () => {
  const card = buildAppointmentCard(appt(), JOB);
  assert.deepEqual(card.service_link, { sent: false, url: null });
});

test("a sent serviceLink is echoed onto every card for the job", () => {
  const ctx = { ok: true, job: JOB, appointments: { upcoming: [appt({ appointment_id: 1 }), appt({ appointment_id: 2 })] } };
  const serviceLink = { sent: true, url: "https://app.servicetrade.com/customer/jobsummary?id=abc123" };
  const cards = buildAppointmentCards(ctx, serviceLink);
  assert.deepEqual(cards[0].service_link, serviceLink);
  assert.deepEqual(cards[1].service_link, serviceLink);
});

test("a serviceLink that hasn't sent yet reports sent:false even if partially populated", () => {
  const card = buildAppointmentCard(appt(), JOB, { sent: false, url: null });
  assert.deepEqual(card.service_link, { sent: false, url: null });
});

// ── onsite_instructions — company content, general + service-line-specific ──

test("with no onsite instructions configured, the card carries an empty array", () => {
  const card = buildAppointmentCard(appt(), JOB);
  assert.deepEqual(card.onsite_instructions, []);
});

test("general (service_line: null) instructions apply to every card regardless of its own service_line", () => {
  const all = [{ service_line: null, instruction: "General note.", requires_response: false }];
  const card = buildAppointmentCard(appt({ service_line: "Backflow" }), JOB, null, all);
  assert.deepEqual(card.onsite_instructions, [{ text: "General note.", requires_response: false }]);
});

test("service-line-specific instructions only attach to a matching card, never a different one", () => {
  const all = [
    { service_line: null, instruction: "General note.", requires_response: false },
    { service_line: "Fire Alarm Inspection", instruction: "Ask about the gate code.", requires_response: true },
  ];
  const matching = buildAppointmentCard(appt({ service_line: "Fire Alarm Inspection" }), JOB, null, all);
  const nonMatching = buildAppointmentCard(appt({ service_line: "Backflow" }), JOB, null, all);

  assert.deepEqual(matching.onsite_instructions, [
    { text: "General note.", requires_response: false },
    { text: "Ask about the gate code.", requires_response: true },
  ]);
  assert.deepEqual(nonMatching.onsite_instructions, [{ text: "General note.", requires_response: false }]);
});

test("buildAppointmentCards resolves onsite instructions per-card, not once for the whole job", () => {
  const all = [
    { service_line: "Fire Alarm Inspection", instruction: "Fire alarm note.", requires_response: false },
    { service_line: "Backflow", instruction: "Backflow note.", requires_response: false },
  ];
  const ctx = {
    ok: true, job: JOB,
    appointments: { upcoming: [appt({ appointment_id: 1, service_line: "Fire Alarm Inspection" }), appt({ appointment_id: 2, service_line: "Backflow" })] },
  };
  const cards = buildAppointmentCards(ctx, null, all);
  assert.deepEqual(cards[0].onsite_instructions, [{ text: "Fire alarm note.", requires_response: false }]);
  assert.deepEqual(cards[1].onsite_instructions, [{ text: "Backflow note.", requires_response: false }]);
});

test("requires_response is normalized to a strict boolean", () => {
  const all = [{ service_line: null, instruction: "Note.", requires_response: undefined }];
  const card = buildAppointmentCard(appt(), JOB, null, all);
  assert.equal(card.onsite_instructions[0].requires_response, false);
});
