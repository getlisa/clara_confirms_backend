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

test("never greets the site as if it were a person", () => {
  // The old prompt opened with a VERBATIM "Hi Acme Property Group, this request
  // is regarding…" — greeting a location by name as though it were the human
  // reading it. That is the specific bug the site-is-a-place rule fixes.
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday, May 28, 2026 at 10:00 AM")] }),
    { companyName: "Clara Fire", isOpeningTurn: true });

  assert.doesNotMatch(out, /Hi Acme Property Group,/,
    "the customer/location name must never be used as a salutation");
  assert.match(out, /is a LOCATION NAME — not a person/);
  assert.match(out, /Never address "Acme Property Group" as if it's a person/);
});

test("addresses the CONTACT by their own name when there is one", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday, May 28, 2026 at 10:00 AM")] }),
    { companyName: "Clara Fire", isOpeningTurn: true, recipientName: "Jordan Blake" });

  assert.match(out, /You are texting Jordan Blake\./);
  assert.doesNotMatch(out, /Hi Acme Property Group,/,
    "greeting a property manager by the site's name reads as a mistake");
});

test("says outright that we do not know the name, rather than naming the account", () => {
  // Changed deliberately (migration 095). This used to read "You are texting the
  // customer." with customerName falling back to the customer record — but on
  // this platform that record is an ACCOUNT, never a person: every customer row
  // has first_name/last_name NULL and a full_name like "Holiday Inn Express-NE
  // City", and on 72 of 215 live jobs it is the same string as the location. A
  // neutral noun was harmless; the account name was not, so the fallback is gone
  // entirely and the model is told the name is unknown.
  const out = prompt.build(ctx({ customerName: null, upcoming: [] }), { companyName: "Clara Fire" });
  assert.match(out, /do not have the NAME of the person on the other end/);
  assert.match(out, /never guess one/);
  assert.doesNotMatch(out, /You are texting/, "there is nobody to name");
  assert.ok(!out.includes("null"));
});

test("the representative is named, and defaults when the company has not set one", () => {
  const withRep = prompt.build(ctx({ upcoming: [] }), { companyName: "Clara Fire", representativeName: "Robin" });
  assert.match(withRep, /^You are Robin, a friendly and professional scheduling assistant for Clara Fire/);
  const without = prompt.build(ctx({ upcoming: [] }), { companyName: "Clara Fire" });
  assert.match(without, /^You are Clara, /);
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
  assert.ok(!out.includes("We have no email on file"));
});

test("asks for an email when none is on file", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday")] }), { companyName: "Clara Fire" });

  assert.match(out, /We have no email on file for this conversation — ask for it/);
});

test("a missing phone never renders as the string 'null'", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday")] }),
    { companyName: "Clara Fire", recipientEmail: "jordan@pm.test", recipientPhone: null });

  assert.ok(!/\bnull\b/.test(out), "a null line item must not reach the model as text");
  assert.ok(!out.includes("as the phone argument"));
});

test("a known phone is offered to the resolve tool", () => {
  const out = prompt.build(ctx({ upcoming: [appt(1, "Thursday")] }),
    { companyName: "Clara Fire", recipientPhone: "+15559998888" });

  assert.match(out, /and \+15559998888 as the phone argument/);
});

// ── 3. The appointment picture itself ────────────────────────────────────────

test("lists every upcoming appointment inline up to 8, with confirmed state", () => {
  const upcoming = [
    appt(11, "Thursday, May 28, 2026 at 10:00 AM", { service_line: "Sprinkler", technician: "Dana Reed" }),
    appt(12, "Monday, June 15, 2026 at 9:00 AM", { customer_confirmed: true }),
  ];
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire" });

  assert.match(out, /- Upcoming appointments: 2/);
  assert.match(out, /- Full upcoming list:/);
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

  assert.match(out, /^Past visits:$/m);
  assert.ok(out.includes("- Appointment #9: Monday, January 5, 2026 at 8:00 AM for Backflow (completed)"));
  assert.ok(!out.includes("#9: Monday, January 5, 2026 at 8:00 AM for Backflow (not yet confirmed)"));
});

test("above 8 upcoming, the list is summarized and the model is pointed at pagination", () => {
  const upcoming = Array.from({ length: 12 }, (_, i) => appt(200 + i, `Visit ${i + 1} date`));
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire" });

  assert.match(out, /- Upcoming appointments: 12/);
  assert.ok(out.includes("...plus 11 more, scheduled through Visit 12 date."));
  assert.ok(out.includes("list_upcoming_appointments"));
  assert.ok(!out.includes("Appointment #205"), "the middle of the list must not be half-shown");
});

test("exactly 8 upcoming is still listed in full (boundary)", () => {
  const upcoming = Array.from({ length: 8 }, (_, i) => appt(300 + i, `Visit ${i + 1} date`));
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire" });

  assert.match(out, /- Upcoming appointments: 8/);
  assert.ok(out.includes("- Appointment #307:"));
});

test("no upcoming appointment says so plainly", () => {
  const out = prompt.build(ctx({ upcoming: [], phase: "no_appointment" }), { companyName: "Clara Fire" });
  assert.match(out, /- Upcoming appointments: 0/);
  assert.match(out, /none booked/);
});

// ── 4. Which appointment to ask about ────────────────────────────────────────

test("targets the earliest UNCONFIRMED appointment, not simply the earliest one", () => {
  const upcoming = [
    appt(11, "Thursday, May 28, 2026 at 10:00 AM", { customer_confirmed: true }),
    appt(12, "Monday, June 15, 2026 at 9:00 AM", { service_line: "Backflow" }),
  ];
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire", isOpeningTurn: true });

  assert.match(out, /confirm appointment #12 — the earliest one still marked "not yet confirmed."/);
  assert.match(out, /- Next appointment: ID 12 \| Monday, June 15, 2026 at 9:00 AM/,
    "the header must name the unconfirmed one, not the earlier confirmed one");
});

test("the opening greeting names the specific service request when there is one", () => {
  const upcoming = [appt(11, "Thursday, May 28, 2026 at 10:00 AM", {
    service_line: "Sprinkler / Fire Protection",
    services: [{ description: "Fix the broken flanges" }],
  })];
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire", isOpeningTurn: true });

  assert.match(out, /I'm reaching out about the Sprinkler \/ Fire Protection visit at Acme Property Group/,
    "the opening names the service and the site, and never salutes the site");
  assert.doesNotMatch(out, /Hi Acme Property Group,/);
});

test("the greeting falls back to the job description when the appointment has no service detail", () => {
  const out = prompt.build(
    ctx({ description: "Yearly sprinkler inspection", upcoming: [appt(11, "Thursday, May 28, 2026 at 10:00 AM")] }),
    { companyName: "Clara Fire", isOpeningTurn: true }
  );

  assert.match(out, /I'm reaching out about the/);
  assert.doesNotMatch(out, /Hi Acme Property Group,/);
});

test("names the technician in the opening example when one is already assigned", () => {
  const out = prompt.build(
    ctx({ upcoming: [appt(11, "Thursday, May 28, 2026 at 10:00 AM", {
      service_line: "Alarm Systems", technician: "Dana Reed", technician_summary: "Dana Reed",
    })] }),
    { companyName: "Clara Fire", isOpeningTurn: true }
  );
  assert.match(out, /with Dana Reed on the visit/);
});

// ── 4b. The opening message is a short greeting only — the rest waits ───────
// Observed live: the opener was crammed with the raw job description AND the
// full onsite-expectations + noise/access question, reading as one dense wall
// of text. Fixed by making the opener explicitly minimal and moving onsite
// expectations to fire only once the visit is actually confirmed.

test("the opening message instructs a short greeting only — no description, no onsite expectations", () => {
  const out = prompt.build(ctx({ upcoming: [appt(11, "Thursday, May 28, 2026 at 10:00 AM")] }),
    { companyName: "Clara Fire", isOpeningTurn: true });
  assert.match(out, /keep it SHORT, a simple greeting and nothing/i);
  assert.match(out, /Do NOT include the job's[\s\S]*description\/notes, onsite expectations, or a noise\/access question here/);
});

test("the job description is flagged as background only, never for verbatim recital in the opener", () => {
  const out = prompt.build(
    ctx({ description: "Zone 401: Fire Sprinkler Waterflow alerts clearing back-to-back", upcoming: [appt(11, "Thursday")] }),
    { companyName: "Clara Fire" }
  );
  assert.match(out, /background for you only; don't recite this verbatim to the customer, and never in the opening message/);
});

test("onsite expectations are sequenced AFTER confirming, not before — CASE A", () => {
  const out = prompt.build(ctx({ upcoming: [appt(11, "Thursday, May 28, 2026 at 10:00 AM")] }), {
    companyName: "Clara Fire",
    serviceLineDescriptions: [{ title: "Alarm Systems", description: "Technician tests each device." }],
  });
  const confirmedIdx = out.indexOf("You're all set");
  const onsiteRefIdx = out.indexOf("Deliver onsite expectations and ask the noise/access question");
  const arrivalRefIdx = out.indexOf("Deliver the arrival window (see ARRIVAL WINDOW below)");
  assert.ok(confirmedIdx > -1 && onsiteRefIdx > -1 && arrivalRefIdx > -1, "all three markers must be present");
  assert.ok(confirmedIdx < onsiteRefIdx, "onsite expectations must be referenced AFTER the confirmation message, not before");
  assert.ok(onsiteRefIdx < arrivalRefIdx, "onsite expectations must come before the arrival window");
});

test("without service line descriptions configured, no dangling onsite-expectations pointer is left anywhere", () => {
  const out = prompt.build(ctx({ upcoming: [appt(11, "Thursday")] }), { companyName: "Clara Fire" });
  assert.ok(!out.includes("Deliver onsite expectations and ask the noise/access question"),
    "no company-specific reference data means nothing to point at");
  assert.ok(!out.includes("ONSITE EXPECTATIONS"), "the section itself is still omitted entirely when unconfigured");
});

// ── 5. Phase branches must actually differ ───────────────────────────────────
// This is the pre-existing bug the change fixed: agentNode never passed
// state.phase, so all three branches collapsed into the "confirming" one.

test("each phase produces a distinct goal block", () => {
  const withAppt = [appt(11, "Thursday", { customer_confirmed: true })];
  const confirming = prompt.build(ctx({ upcoming: [appt(11, "Thursday")], phase: "confirming" }), { companyName: "C" });
  const allConfirmed = prompt.build(ctx({ upcoming: withAppt, phase: "all_confirmed" }), { companyName: "C" });
  const none = prompt.build(ctx({ upcoming: [], phase: "no_appointment" }), { companyName: "C" });

  assert.match(confirming, /Your primary goal is to confirm appointment #11/);
  assert.match(allConfirmed, /Everything upcoming is already confirmed — go straight to CASE B/);
  assert.match(none, /There are no upcoming appointments — go straight to CASE C/);

  assert.doesNotMatch(allConfirmed, /Your primary goal is to confirm appointment/);
  assert.doesNotMatch(none, /Your primary goal is to confirm appointment/);
  assert.equal(new Set([confirming, allConfirmed, none]).size, 3);
});

test("an all-confirmed job does not open by re-asking for confirmation", () => {
  const out = prompt.build(
    ctx({ upcoming: [appt(11, "Thursday, May 28, 2026 at 10:00 AM", { customer_confirmed: true })], phase: "all_confirmed" }),
    { companyName: "Clara Fire", isOpeningTurn: true }
  );

  assert.match(out, /Everything upcoming is already confirmed — go straight to CASE B/);
  assert.match(out, /Don't ask for confirmation as if nothing's on file/);
});

// ── 6. Someone else already confirmed ────────────────────────────────────────

test("confirmed-by-another-recipient overrides both the greeting and the goal", () => {
  const out = prompt.build(
    ctx({ upcoming: [appt(11, "Thursday")] }),
    { companyName: "Clara Fire", isOpeningTurn: true, confirmedByOtherLabel: "Jordan Blake" });

  assert.ok(out.includes("ALREADY CONFIRMED BY SOMEONE ELSE"));
  assert.ok(out.includes("already been confirmed by Jordan Blake"));
  assert.doesNotMatch(out, /Your primary goal is to confirm appointment/);
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

  assert.match(out, /ONSITE EXPECTATIONS \+ NOISE & ACCESS/);
  assert.ok(out.includes("Sprinkler / Fire Protection:\nA technician inspects every sprinkler head and the riser."));
  assert.ok(out.includes("Backflow:\nAnnual backflow preventer test."));

  // These notes are what a site needs in order to prepare — tenant notice,
  // unlocked units, an expected alarm. Answering only when asked means a
  // confirmation can complete without any of it being said, which is the bug
  // this wording replaced.
  assert.ok(/don't wait to be asked/i.test(out), "must be proactive, not reference-only");
  assert.match(out, /Every confirmation must tell the customer what to expect/i);
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
    assert.match(out, new RegExp(`- Upcoming appointments: ${n}\\b`),
      "the stated count and the rendered list must never disagree");
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

// ── Duplicate opening message ────────────────────────────────────────────────
//
// Observed live on thread ff7e8e44…: the agent emitted its greeting AND called
// report_customer_intent in the same message. A tool call routes the graph
// agent → tools → recompute_context → agent, so the agent ran a second time and
// greeted all over again — two openings inside one turn, one trigger message,
// nothing in the logs suggesting ensureOpened had run twice.
//
// Two layers guard it: the tool is withheld on the opening turn (structural),
// and the prompt forbids re-greeting once the agent has spoken (belt and braces).

const { getToolsForPhase } = require("../src/confirmation-agent/tools/registry");

test("the opening turn cannot call report_customer_intent — the customer has said nothing yet", () => {
  const opening = getToolsForPhase("confirming", { isOpeningTurn: true }).map((t) => t.name);
  assert.ok(!opening.includes("report_customer_intent"),
    "a tool call in the opening message sends the graph back through the agent, which then re-greets");
  assert.ok(!opening.includes("end_conversation"),
    "there is nothing to end before the conversation has started");
  assert.ok(opening.includes("confirm_appointment"), "the phase's real actions are still available");
});

test("every later turn gets both tools back", () => {
  const later = getToolsForPhase("confirming", { isOpeningTurn: false }).map((t) => t.name);
  assert.ok(later.includes("report_customer_intent"));
  assert.ok(later.includes("end_conversation"));
});

test("defaulting the flag keeps the full tool set — no caller is silently narrowed", () => {
  const bare = getToolsForPhase("confirming").map((t) => t.name);
  assert.ok(bare.includes("report_customer_intent"));
  assert.ok(bare.includes("end_conversation"));
});

test("once the agent has spoken, the prompt forbids a second greeting", () => {
  const c = ctx({ upcoming: [appt(11, "Thursday")] });
  const opening = prompt.build(c, { companyName: "Clara Fire", isOpeningTurn: true });
  const later = prompt.build(c, { companyName: "Clara Fire", isOpeningTurn: false });

  assert.doesNotMatch(opening, /ALREADY INTRODUCED YOURSELF/,
    "the first message must still be a greeting");
  assert.match(later, /ALREADY INTRODUCED YOURSELF/);
  assert.match(later, /Never send another opening or greeting message/);
});

// ── propose_remaining_appointments — exclusive, not additive ────────────────
// This turn must do NOTHING else — no greeting, no confirm, no end_conversation
// — so the gate makes it the ONLY tool bound to the model, not one more
// option alongside the phase's usual set.

test("exclusiveTool makes propose_remaining_appointments the ONLY tool offered", () => {
  const names = getToolsForPhase("confirming", { exclusiveTool: "propose_remaining_appointments" }).map((t) => t.name);
  assert.deepEqual(names, ["propose_remaining_appointments"]);
});

test("exclusiveTool overrides isOpeningTurn/phase — still exclusive", () => {
  const names = getToolsForPhase("all_confirmed", { isOpeningTurn: true, exclusiveTool: "propose_remaining_appointments" }).map((t) => t.name);
  assert.deepEqual(names, ["propose_remaining_appointments"]);
});

test("exclusiveTool works for any registered tool name — e.g. a card-driven confirm turn", () => {
  const names = getToolsForPhase("all_confirmed", { exclusiveTool: "confirm_appointment" }).map((t) => t.name);
  assert.deepEqual(names, ["confirm_appointment"]);
});

test("propose_remaining_appointments is never offered outside an exclusive turn for it", () => {
  const confirming = getToolsForPhase("confirming", { isOpeningTurn: false }).map((t) => t.name);
  const allConfirmed = getToolsForPhase("all_confirmed").map((t) => t.name);
  assert.ok(!confirming.includes("propose_remaining_appointments"));
  assert.ok(!allConfirmed.includes("propose_remaining_appointments"));
});

// ── The isProposeRemainingTurn prompt — a completely separate, short prompt ─

test("isProposeRemainingTurn produces a short prompt naming only the still-unconfirmed appointments", () => {
  const upcoming = [
    appt(11, "Thursday, May 28, 2026 at 10:00 AM", { customer_confirmed: true }),
    appt(12, "Monday, June 15, 2026 at 9:00 AM", { service_line: "Backflow" }),
    appt(13, "Tuesday, June 16, 2026 at 9:00 AM", { service_line: "Sprinkler" }),
  ];
  const out = prompt.build(ctx({ upcoming }), { companyName: "Clara Fire", isProposeRemainingTurn: true });

  assert.match(out, /Call propose_remaining_appointments right now/);
  assert.match(out, /Appointment #12/);
  assert.match(out, /Appointment #13/);
  assert.doesNotMatch(out, /Appointment #11/, "already confirmed — not part of 'the rest'");
  assert.doesNotMatch(out, /YOUR OPENING MESSAGE/, "not the normal greeting/goal flow");
  assert.doesNotMatch(out, /GOAL: CONFIRM THE NEXT UPCOMING APPOINTMENT/);
});
