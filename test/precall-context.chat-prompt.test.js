/**
 * "Send the entire context pre-call" — the CHAT path.
 *
 * The chat agent has no get_appointments tool at all: everything it can know
 * is in the system prompt, rebuilt fresh from jobCtx on every turn. These tests
 * pin the contents of that prompt — prompt.build is a pure function, so they
 * run against the real thing with no stubs.
 *
 * The recurring risk is a prompt that reads *plausibly* but states something
 * false: a name for the wrong person, a count that contradicts the list under
 * it, a phase branch that collapsed into another one, or a literal "null".
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const prompt = require("../src/confirmation-agent/graph/prompt");

function appt(id, spoken, extra = {}) {
  return {
    appointment_id: id,
    scheduled_start_spoken: spoken,
    scheduled_end_spoken: null,
    customer_confirmed: false,
    technician_confirmed: false,
    technician: null,
    technicians: [],
    service_line: null,
    services: [],
    status: "scheduled",
    is_next: false,
    ...extra,
  };
}

function ctx({ upcoming = [], history = [], phase = "confirming", customerName = "Acme Property Group",
               title = "Annual Fire Inspection", description = null, comments = [] } = {}) {
  const unconfirmed = upcoming.filter((a) => !a.customer_confirmed).length;
  return {
    ok: true,
    phase,
    job: {
      id: 1, job_number: "48767205", title, description, job_type: "inspection", status: "scheduled",
      scheduled_date: null, comments, notes: [],
      customer: { name: customerName, phone: "+15551230000", email: "ap@acme.test", address: "1 Main St" },
      technician: null,
    },
    appointments: { upcoming, next: upcoming[0] || null, history },
    counts: {
      upcoming: upcoming.length,
      confirmed: upcoming.length - unconfirmed,
      unconfirmed,
      all_confirmed: upcoming.length > 0 && unconfirmed === 0,
    },
  };
}

// ── 1. Who the agent thinks it's talking to ──────────────────────────────────

test("addresses the customer by name when the conversation is with the customer", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday, May 28, 2026 at 10:00 AM")] }),
    { companyName: "Clara Fire", isOpeningTurn: true });

  assert.ok(out.includes("Hi Acme Property Group, this request is regarding"));
});

test("addresses the CONTACT, not the customer, when the conversation is with a contact", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday, May 28, 2026 at 10:00 AM")] }),
    { companyName: "Clara Fire", isOpeningTurn: true, recipientName: "Jordan Blake" });

  assert.ok(out.includes("Hi Jordan Blake, this request is regarding"));
  assert.ok(!out.includes("Hi Acme Property Group"), "greeting a property manager by the customer's name reads as a mistake");
});

test("falls back to a neutral noun when nobody is named", () => {
  const out = prompt.build(ctx({ customerName: null, upcoming: [] }), { companyName: "Clara Fire" });
  assert.ok(out.includes("messaging with the customer"));
  assert.ok(!out.includes("null"));
});

// ── 2. Contact info presented instead of asked for ───────────────────────────

test("reads a known email back and requires an explicit yes before sending", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday")] }),
    { companyName: "Clara Fire", recipientEmail: "jordan@pm.test" });

  // Pinned as intent, not as one exact sentence: the address must be read back
  // rather than asked for blind, and the send must wait for a yes. The tool
  // enforces the same rule (see service-link-email-confirmation.test.js) — the
  // prompt exists so the agent asks rather than getting refused.
  assert.ok(out.includes("jordan@pm.test"), "the known address is presented, not asked for");
  assert.match(out, /is that the right one to send it to\?/);
  assert.match(out, /EXPLICIT YES ON THE ADDRESS BEFORE SENDING/);
  assert.match(out, /email_confirmed=true/);
  assert.ok(!out.includes("you don't have one on file for this conversation"));
});

test("asks for an email when none is on file", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday")] }), { companyName: "Clara Fire" });

  assert.ok(out.includes("Ask for their email — you don't have one on file"));
});

test("a missing phone never renders as the string 'null'", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday")] }),
    { companyName: "Clara Fire", recipientEmail: "jordan@pm.test", recipientPhone: null });

  assert.ok(!/\bnull\b/.test(out), "a null line item must not reach the model as text");
  assert.ok(!out.includes("phone number on file"));
});

test("a known phone is offered to the resolve tool", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday")] }),
    { companyName: "Clara Fire", recipientPhone: "+15559998888" });

  assert.ok(out.includes("phone number on file (+15559998888)"));
});

// ── 3. The appointment picture itself ────────────────────────────────────────

test("lists every upcoming appointment inline up to 8, with confirmed state", () => {
  const upcoming = [
    appt(11, "Thursday, May 28, 2026 at 10:00 AM", { service_line: "Sprinkler", technician: "Dana Reed" }),
    appt(12, "Monday, June 15, 2026 at 9:00 AM", { customer_confirmed: true }),
  ];
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire" });

  assert.ok(out.includes("Upcoming appointments (2):"));
  assert.ok(out.includes("- Appointment #11: Thursday, May 28, 2026 at 10:00 AM for Sprinkler with Dana Reed (not yet confirmed)"));
  assert.ok(out.includes("- Appointment #12: Monday, June 15, 2026 at 9:00 AM (confirmed)"));
});

test("past visits are included with their real status, not confirmed/unconfirmed wording", () => {
  const out = prompt.build(
    ctx({
      upcoming: [appt(11, "Thursday")],
      history: [appt(9, "Monday, January 5, 2026 at 8:00 AM", { status: "completed", service_line: "Backflow" })],
    }),
    { companyName: "Clara Fire" }
  );

  assert.ok(out.includes("Past visits (1):"));
  assert.ok(out.includes("- Appointment #9: Monday, January 5, 2026 at 8:00 AM for Backflow (completed)"));
  assert.ok(!out.includes("#9: Monday, January 5, 2026 at 8:00 AM for Backflow (not yet confirmed)"));
});

test("above 8 upcoming, the list is summarized and the model is pointed at pagination", () => {
  const upcoming = Array.from({ length: 12 }, (_, i) => appt(200 + i, `Visit ${i + 1} date`));
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire" });

  assert.ok(out.includes("Upcoming appointments: 12 total — too many to list here."));
  assert.ok(out.includes("...plus 11 more, scheduled through Visit 12 date."));
  assert.ok(out.includes("list_upcoming_appointments"));
  assert.ok(!out.includes("Appointment #205"), "the middle of the list must not be half-shown");
});

test("exactly 8 upcoming is still listed in full (boundary)", () => {
  const upcoming = Array.from({ length: 8 }, (_, i) => appt(300 + i, `Visit ${i + 1} date`));
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire" });

  assert.ok(out.includes("Upcoming appointments (8):"));
  assert.ok(out.includes("- Appointment #307:"));
});

test("no upcoming appointment says so plainly", () => {
  const out = prompt.build(ctx({ upcoming: [], phase: "no_appointment" }), { companyName: "Clara Fire" });
  assert.ok(out.includes("No upcoming appointment is booked on this job yet."));
});

// ── 4. Which appointment to ask about ────────────────────────────────────────

test("targets the earliest UNCONFIRMED appointment, not simply the earliest one", () => {
  const upcoming = [
    appt(11, "Thursday, May 28, 2026 at 10:00 AM", { customer_confirmed: true }),
    appt(12, "Monday, June 15, 2026 at 9:00 AM", { service_line: "Backflow" }),
  ];
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire", isOpeningTurn: true });

  assert.ok(out.includes("Confirm THIS appointment first: Appointment #12"));
  assert.ok(out.includes("Hi Acme Property Group, this request is regarding your upcoming appointment on Monday, June 15, 2026 at 9:00 AM"));
});

test("the opening greeting names the specific service request when there is one", () => {
  const upcoming = [appt(11, "Thursday, May 28, 2026 at 10:00 AM", {
    service_line: "Sprinkler / Fire Protection",
    services: [{ description: "Fix the broken flanges" }],
  })];
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire", isOpeningTurn: true });

  assert.ok(out.includes("regarding Sprinkler / Fire Protection (Fix the broken flanges)"));
});

test("the greeting falls back to the job description when the appointment has no service detail", () => {
  const out = prompt.build(
    ctx({ description: "Yearly sprinkler inspection", upcoming: [appt(11, "Thursday, May 28, 2026 at 10:00 AM")] }),
    { companyName: "Clara Fire", isOpeningTurn: true }
  );

  assert.ok(out.includes("(Yearly sprinkler inspection)"));
});

// ── 5. Phase branches must actually differ ───────────────────────────────────
// This is the pre-existing bug the change fixed: agentNode never passed
// state.phase, so all three branches collapsed into the "confirming" one.

test("each phase produces a distinct goal block", () => {
  const withAppt = [appt(11, "Thursday", { customer_confirmed: true })];
  const confirming = prompt.build(ctx({ upcoming: [appt(11, "Thursday")], phase: "confirming" }), { companyName: "C" });
  const allConfirmed = prompt.build(ctx({ upcoming: withAppt, phase: "all_confirmed" }), { companyName: "C" });
  const none = prompt.build(ctx({ upcoming: [], phase: "no_appointment" }), { companyName: "C" });

  assert.ok(confirming.includes("YOUR GOAL: CONFIRM THE NEXT UPCOMING APPOINTMENT"));
  assert.ok(allConfirmed.includes("EVERYTHING IS ALREADY CONFIRMED"));
  assert.ok(none.includes("YOUR GOAL: SCHEDULE A VISIT"));

  assert.ok(!allConfirmed.includes("YOUR GOAL: CONFIRM THE NEXT UPCOMING APPOINTMENT"));
  assert.ok(!none.includes("YOUR GOAL: CONFIRM THE NEXT UPCOMING APPOINTMENT"));
  assert.equal(new Set([confirming, allConfirmed, none]).size, 3);
});

test("an all-confirmed job does not open by re-asking for confirmation", () => {
  const out = prompt.build(
    ctx({ upcoming: [appt(11, "Thursday, May 28, 2026 at 10:00 AM", { customer_confirmed: true })], phase: "all_confirmed" }),
    { companyName: "Clara Fire", isOpeningTurn: true }
  );

  assert.ok(!out.includes("send EXACTLY this as your opening line"), "the verbatim confirm-me greeting is wrong here");
  assert.ok(out.includes("Do not ask for confirmation as though nothing is on file"));
});

// ── 6. Someone else already confirmed ────────────────────────────────────────

test("confirmed-by-another-recipient overrides both the greeting and the goal", () => {
  const out = prompt.build(
    ctx({ upcoming: [appt(11, "Thursday")] }),
    { companyName: "Clara Fire", isOpeningTurn: true, confirmedByOtherLabel: "Jordan Blake" });

  assert.ok(out.includes("ALREADY CONFIRMED BY SOMEONE ELSE"));
  assert.ok(out.includes("already been confirmed by Jordan Blake"));
  assert.ok(!out.includes("YOUR GOAL: CONFIRM THE NEXT UPCOMING APPOINTMENT"));
  assert.ok(!out.includes("send EXACTLY this as your opening line"));
});

// ── 7. Service-line reference material ───────────────────────────────────────

test("service line descriptions are injected, and must be STATED rather than kept in reserve", () => {
  const out = prompt.build(ctx({ upcoming: [appt(11, "Thursday")] }), {
    companyName: "Clara Fire",
    serviceLineDescriptions: [
      { title: "Sprinkler / Fire Protection", description: "A technician inspects every sprinkler head and the riser." },
      { title: "Backflow", description: "Annual backflow preventer test." },
    ],
  });

  assert.ok(out.includes("── ONSITE EXPECTATIONS"));
  assert.ok(out.includes("Sprinkler / Fire Protection:\nA technician inspects every sprinkler head and the riser."));
  assert.ok(out.includes("Backflow:\nAnnual backflow preventer test."));

  // These notes are what a site needs in order to prepare — tenant notice,
  // unlocked units, an expected alarm. Answering only when asked means a
  // confirmation can complete without any of it being said, which is the bug
  // this wording replaced.
  assert.ok(/don't wait to be asked/i.test(out), "must be proactive, not reference-only");
  assert.ok(/must tell the customer what to expect onsite/i.test(out));
  assert.ok(!/when the customer asks what the visit involves/i.test(out),
    "the old reactive instruction must not linger alongside the new one");

  assert.ok(/never invent access or noise specifics/i.test(out), "the model must not force a match");
  assert.ok(/single combined entry/i.test(out),
    "a visit bundling several services needs one combined entry, not two read out");
});

test("no descriptions configured — the block is omitted entirely, not left empty", () => {
  const out = prompt.build(ctx({ upcoming: [appt(11, "Thursday")] }), { companyName: "Clara Fire" });
  assert.ok(!out.includes("ONSITE EXPECTATIONS"));
  assert.ok(!out.includes("SERVICE DETAILS"));
});

// ── 8. Cross-cutting invariants ──────────────────────────────────────────────

test("the prompt never contains an unrendered value or a raw timestamp", () => {
  const out = prompt.build(
    ctx({
      description: "Yearly sprinkler inspection",
      comments: ["Gate code 4417"],
      upcoming: [appt(11, "Thursday, May 28, 2026 at 10:00 AM", { service_line: "Sprinkler", technician: "Dana Reed" })],
      history: [appt(9, "Monday, January 5, 2026 at 8:00 AM", { status: "completed" })],
    }),
    { companyName: "Clara Fire", isOpeningTurn: true, recipientName: "Jordan Blake",
      recipientEmail: "jordan@pm.test", recipientPhone: "+15559998888",
      serviceLineDescriptions: [{ title: "Sprinkler", description: "Head-by-head inspection." }] }
  );

  assert.ok(!/\bundefined\b/.test(out));
  assert.ok(!/\bnull\b/.test(out));
  assert.ok(!/\[object Object\]/.test(out));
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(out), "raw ISO timestamps must never reach the agent");
});

test("the count in the header always matches the number of lines under it", () => {
  for (const n of [1, 2, 5, 8]) {
    const upcoming = Array.from({ length: n }, (_, i) => appt(400 + i, `Visit ${i + 1}`));
    const out = prompt.build(ctx({ upcoming }), { companyName: "C" });
    const listed = out.split("\n").filter((l) => /^- Appointment #4\d\d:/.test(l)).length;
    assert.equal(listed, n, `header says ${n} upcoming but ${listed} were listed`);
    assert.ok(out.includes(`Upcoming appointments (${n}):`));
  }
});

test("the anti-hallucination rule survives every branch", () => {
  const variants = [
    prompt.build(ctx({ upcoming: [], phase: "no_appointment" }), { companyName: "C" }),
    prompt.build(ctx({ upcoming: [appt(1, "Thursday")] }), { companyName: "C" }),
    prompt.build(ctx({ upcoming: [appt(1, "Thursday", { customer_confirmed: true })], phase: "all_confirmed" }), { companyName: "C" }),
    prompt.build(ctx({ upcoming: [appt(1, "Thursday")] }), { companyName: "C", confirmedByOtherLabel: "Jordan Blake" }),
  ];
  for (const out of variants) {
    assert.ok(out.includes("Never invent an appointment, date, technician, service, or count"));
    assert.ok(out.includes("end_conversation"), "every branch still needs a defined way to end");
  }
});
