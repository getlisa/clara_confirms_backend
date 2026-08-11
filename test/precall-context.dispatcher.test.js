/**
 * "Send the entire context pre-call" — the VOICE path.
 *
 * The change moved the job's appointment picture out of the get_appointments
 * tool round-trip and into Retell's dynamic variables, bound at dispatch. These
 * tests drive the real runDispatcher end-to-end (real job-confirmation-context,
 * real spoken-date formatting) against a fake DB, and assert on exactly what
 * would be handed to Retell as `retell_llm_dynamic_variables`.
 *
 * What matters here is not "does it set a variable" but the properties the
 * agent's prompt depends on:
 *   - every value is a STRING (Retell rejects/renders others badly)
 *   - no raw ISO timestamp ever reaches the agent (it reads them aloud)
 *   - the pre-bound `next_*` facts agree with the pre-rendered list
 *   - a missing/failed context degrades to BLANK, which is the prompt's
 *     documented "fall back to get_appointments" signal — never to a wrong value
 */

process.env.NODE_ENV = "development"; // isDev: skip office-hours gating, not under test
process.env.LOG_LEVEL = "error";

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
const { createFakeDb } = require("./helpers/fake-db");
const { inDays, appointment, job, scheduledCallRow } = require("./helpers/fixtures");

// ── Stubs must be installed before the module under test is required ─────────
const fakeDb = createFakeDb();
const logger = silentLogger();
stub("db/index.js", fakeDb);
stub("utils/logger.js", logger);

const jobsDb = stub("db/jobs.js", {
  getJobById: async () => null,
  fetchJobServiceLines: async () => [],
});

let claimed = [];
const completed = [];
const failures = [];
stub("db/scheduled-calls.js", {
  claimPending: async () => claimed,
  markCompleted: async (id, externalId) => { completed.push({ id, externalId }); },
  markCompletedWithChatLink: async () => {},
  markFailedOrRetry: async (id, message) => { failures.push({ id, message }); return "pending"; },
  advanceToNextWindow: async () => {},
  create: async () => ({ id: 1 }),
});

stub("db/call-settings.js", { getByCompanyId: async () => ({ auto_dispatch_enabled: true, chat_link_delivery_method: "email" }) });
stub("db/call-trigger-configs.js", { getEnabledByCompanyId: async () => [] });
stub("db/call-type-configs.js", {
  getByType: async () => ({ voicemail_message: "Hi {{customer_name}}, please call us back." }),
  generateDefaultVoicemailMessage: () => "Please call us back.",
});
stub("db/todos.js", {});
stub("services/chat-links.js", { createChatLinkForJob: async () => ({ ok: true, token: "tok" }), createChatLinkForAppointment: async () => ({ ok: true, token: "tok" }) });
stub("services/chat-link-email.js", { sendConfirmationLinkEmail: async () => {} });
stub("services/chat-link-sms.js", { sendConfirmationLinkSms: async () => {} });

let lastCall = null;
stub("services/retell.js", {
  createCall: async (args) => { lastCall = args; return { call_id: "call_abc" }; },
  createSmsChat: async () => ({ chat_id: "chat_abc" }),
});

const scheduler = require("../src/services/scheduler");

// ── Harness ──────────────────────────────────────────────────────────────────

/**
 * Run one dispatcher pass for a single claimed row and return the dynamic
 * variables that would have gone to Retell.
 */
async function dispatch({ row = {}, jobRecord = null, customerContact = null, comments = [], crew = [] } = {}) {
  fakeDb.reset();
  logger.reset();
  lastCall = null;
  completed.length = 0;
  failures.length = 0;

  fakeDb.on("FROM companies WHERE id", [{ default_timezone: "America/New_York" }]);
  fakeDb.on("FROM scheduled_calls sc", []);
  fakeDb.on("company_name", [{ company_name: "Clara Fire", representative_name: "Clara" }]);
  fakeDb.on("FROM appointment_technicians", crew);
  fakeDb.on("FROM scheduling_comments", comments.map((content) => ({ content })));
  fakeDb.on("FROM job_notes", []);
  fakeDb.on("FROM jobs j JOIN customers c", customerContact ? [customerContact] : []);

  jobsDb.getJobById = async () => jobRecord;

  claimed = [scheduledCallRow(row)];
  const result = await scheduler.runDispatcher(10);
  return { vars: lastCall?.dynamicVariables ?? null, call: lastCall, result };
}

const ISO_LIKE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

function assertRetellSafe(vars) {
  for (const [k, v] of Object.entries(vars)) {
    assert.equal(typeof v, "string", `dynamic variable ${k} must be a string, got ${typeof v} (${v})`);
    assert.ok(!ISO_LIKE.test(v), `dynamic variable ${k} leaks a raw ISO timestamp the agent would read aloud: ${v}`);
  }
}

// ── 1. The normal case: several upcoming, one unconfirmed ────────────────────

test("binds the whole appointment picture for a multi-appointment job", async () => {
  const { vars } = await dispatch({
    jobRecord: job({
      appointments: [
        appointment({ id: 11, start: inDays(3), serviceLine: "Sprinkler / Fire Protection", technicianName: "Dana Reed" }),
        appointment({ id: 12, start: inDays(30), serviceLine: "Backflow", customerConfirmed: true }),
        appointment({ id: 13, start: inDays(60), serviceLine: "Extinguisher" }),
      ],
    }),
  });

  assert.equal(vars.upcoming_count, "3");
  assert.equal(vars.unconfirmed_count, "2");
  assert.equal(vars.all_upcoming_confirmed, "false");
  assert.equal(vars.next_appointment_id, "11");
  assert.equal(vars.next_service_line, "Sprinkler / Fire Protection");
  assert.equal(vars.next_technician, "Dana Reed");
  assert.match(vars.next_appointment_date, /^[A-Z][a-z]+day, /);

  const lines = vars.upcoming_appointments.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^#11 .* for Sprinkler \/ Fire Protection with Dana Reed \(not yet confirmed\)$/);
  assert.match(lines[1], /^#12 .* for Backflow \(confirmed\)$/);
  assert.match(lines[2], /^#13 .* for Extinguisher \(not yet confirmed\)$/);
  assertRetellSafe(vars);
});

test("upcoming list is earliest-first even though the DB hands it back newest-first", async () => {
  const { vars } = await dispatch({
    jobRecord: job({
      appointments: [
        appointment({ id: 33, start: inDays(90) }),
        appointment({ id: 31, start: inDays(2) }),
        appointment({ id: 32, start: inDays(45) }),
      ],
    }),
  });

  const ids = vars.upcoming_appointments.split("\n").map((l) => l.match(/^#(\d+)/)[1]);
  assert.deepEqual(ids, ["31", "32", "33"]);
  // The pre-bound `next_*` block and the pre-rendered list must never disagree
  // — the agent confirms with next_appointment_id but reads dates off the list.
  assert.equal(vars.next_appointment_id, "31");
  assert.equal(vars.upcoming_appointments.split("\n")[0].includes(vars.next_appointment_date), true);
});

// ── 2. Counting edge cases the opening script branches on ────────────────────

test("exactly one upcoming appointment", async () => {
  const { vars } = await dispatch({
    jobRecord: job({ appointments: [appointment({ id: 21, start: inDays(4), serviceLine: "Sprinkler" })] }),
  });

  assert.equal(vars.upcoming_count, "1");
  assert.equal(vars.unconfirmed_count, "1");
  assert.equal(vars.all_upcoming_confirmed, "false");
  assert.equal(vars.upcoming_appointments.split("\n").length, 1);
});

test("every upcoming appointment already confirmed", async () => {
  const { vars } = await dispatch({
    jobRecord: job({
      appointments: [
        appointment({ id: 41, start: inDays(5), customerConfirmed: true }),
        appointment({ id: 42, start: inDays(15), customerConfirmed: true }),
      ],
    }),
  });

  assert.equal(vars.all_upcoming_confirmed, "true");
  assert.equal(vars.unconfirmed_count, "0");
  assert.ok(!vars.upcoming_appointments.includes("(not yet confirmed)"));
});

test("no upcoming appointments — counts are zero and no next_* facts are invented", async () => {
  const { vars } = await dispatch({
    jobRecord: job({
      appointments: [appointment({ id: 51, start: inDays(-10), status: "completed" })],
    }),
  });

  assert.equal(vars.upcoming_count, "0");
  assert.equal(vars.unconfirmed_count, "0");
  assert.equal(vars.all_upcoming_confirmed, "false");
  assert.equal(vars.next_appointment_id, undefined);
  assert.equal(vars.upcoming_appointments, undefined);
});

test("past and cancelled appointments never count as upcoming", async () => {
  const { vars } = await dispatch({
    jobRecord: job({
      appointments: [
        appointment({ id: 61, start: inDays(-3), status: "completed" }),
        appointment({ id: 62, start: inDays(7), status: "cancelled" }),
        appointment({ id: 63, start: inDays(9), status: "rescheduled" }),
        appointment({ id: 64, start: inDays(11), status: "confirmed", customerConfirmed: true }),
      ],
    }),
  });

  assert.equal(vars.upcoming_count, "2", "only the rescheduled + confirmed future visits are upcoming");
  assert.equal(vars.next_appointment_id, "63");
  assert.ok(!vars.upcoming_appointments.includes("#62"), "a cancelled visit must not be offered for confirmation");
});

// ── 3. The 8-appointment cap ─────────────────────────────────────────────────

function manyAppointments(n, startDay = 2) {
  return Array.from({ length: n }, (_, i) =>
    appointment({ id: 100 + i, start: inDays(startDay + i * 7), serviceLine: "Quarterly Inspection" })
  );
}

test("exactly 8 upcoming — full list, no truncation tail", async () => {
  const { vars } = await dispatch({ jobRecord: job({ appointments: manyAppointments(8) }) });

  assert.equal(vars.upcoming_count, "8");
  assert.equal(vars.upcoming_appointments.split("\n").length, 8);
  assert.ok(!vars.upcoming_appointments.includes("plus"));
});

test("9 upcoming — truncated at 8 with a tail pointing back at the tool", async () => {
  const { vars } = await dispatch({ jobRecord: job({ appointments: manyAppointments(9) }) });

  const lines = vars.upcoming_appointments.split("\n");
  assert.equal(vars.upcoming_count, "9", "the COUNT stays truthful even though the list is capped");
  assert.equal(lines.length, 9, "8 appointments + 1 tail line");
  assert.equal(lines[8], "...plus 1 more — call get_appointments to see the rest.");
});

test("30 upcoming (recurring-service contract) — count truthful, list bounded", async () => {
  const { vars } = await dispatch({ jobRecord: job({ appointments: manyAppointments(30) }) });

  const lines = vars.upcoming_appointments.split("\n");
  assert.equal(vars.upcoming_count, "30");
  assert.equal(lines.length, 9);
  assert.equal(lines[8], "...plus 22 more — call get_appointments to see the rest.");
  assert.ok(vars.upcoming_appointments.length < 2000, "the list rides in every turn's context — it must stay bounded");
});

// ── 4. Missing fields on the next appointment ────────────────────────────────

test("no technician assigned — next_technician is blank, not 'null' or 'undefined'", async () => {
  const { vars } = await dispatch({
    jobRecord: job({ appointments: [appointment({ id: 71, start: inDays(3), serviceLine: "Sprinkler" })] }),
  });

  assert.equal(vars.next_technician, "");
  assert.ok(!vars.upcoming_appointments.includes("with null"));
  assert.ok(!vars.upcoming_appointments.includes("with undefined"));
});

test("no service line on the appointment — falls back to the job title", async () => {
  const { vars } = await dispatch({
    jobRecord: job({ title: "Annual Fire Inspection", appointments: [appointment({ id: 72, start: inDays(3) })] }),
  });

  assert.equal(vars.next_service_line, "Annual Fire Inspection");
  assert.ok(!vars.upcoming_appointments.includes("for null"));
});

test("no service line and no job title — falls back to a speakable phrase", async () => {
  const { vars } = await dispatch({
    jobRecord: job({ title: null, appointments: [appointment({ id: 73, start: inDays(3) })] }),
  });

  assert.equal(vars.next_service_line, "your upcoming visit");
});

// ── 5. Degradation: the context could not be built ───────────────────────────

test("job not found — appointment vars are absent (blank), and the call still fires", async () => {
  const { vars, result } = await dispatch({ jobRecord: null });

  for (const k of ["upcoming_count", "unconfirmed_count", "all_upcoming_confirmed",
                   "next_appointment_id", "next_service_line", "next_appointment_date",
                   "next_technician", "upcoming_appointments"]) {
    assert.equal(vars[k], undefined, `${k} must be absent so the prompt's blank-value fallback fires`);
  }
  assert.equal(result.fired, 1, "a missing context degrades to tool-fetch, it does not fail the call");
  assert.equal(logger.records.warn.length > 0, true, "the degradation is logged");
});

test("synthetic job ids (quotation:N) skip the job-context block entirely", async () => {
  const { vars } = await dispatch({
    row: { call_type: "quotation_followup", job_id: "quotation:44", total_amount: 1250.5 },
  });

  assert.equal(vars.upcoming_count, undefined);
  assert.equal(vars.total_amount, "1250.5");
  assert.equal(fakeDb.matched("FROM appointment_technicians").length, 0, "no job context is built for a non-job id");
});

test("a non-confirmation call type gets no appointment context", async () => {
  const { vars } = await dispatch({
    row: { call_type: "technician_confirmation", appointment_id: 900 },
    jobRecord: job({ appointments: [appointment({ id: 81, start: inDays(3) })] }),
  });

  assert.equal(vars.upcoming_count, undefined);
  assert.equal(vars.appointment_id, "900", "technician_confirmation still gets its own single appointment id");
});

// ── 6. Who are we actually talking to ────────────────────────────────────────

test("a confirmation contact is addressed by their own name, not the customer's", async () => {
  const { vars } = await dispatch({
    row: {
      customer_name: "Acme Property Group",
      recipient_contact_id: 12,
      recipient_name: "Jordan Blake",
      recipient_email: "jordan@pm.test",
      phone_number: "+15559998888",
    },
    jobRecord: job({ appointments: [appointment({ id: 91, start: inDays(3) })] }),
  });

  assert.equal(vars.customer_name, "Jordan Blake");
  assert.equal(vars.customer_email, "jordan@pm.test");
  assert.equal(vars.customer_phone, "+15559998888");
  assert.equal(
    fakeDb.matched("FROM jobs j JOIN customers c").length, 0,
    "a recipient row carries its own snapshot — no extra customer lookup at dispatch"
  );
});

test("no recipient contact — falls back to the customer's own name and freshly-read contact info", async () => {
  const { vars } = await dispatch({
    row: { customer_name: "Acme Property Group" },
    customerContact: { email: "ap@acme.test", phone: "+15551230000" },
    jobRecord: job({ appointments: [appointment({ id: 92, start: inDays(3) })] }),
  });

  assert.equal(vars.customer_name, "Acme Property Group");
  assert.equal(vars.customer_email, "ap@acme.test");
  assert.equal(vars.customer_phone, "+15551230000");
  assert.equal(fakeDb.matched("FROM jobs j JOIN customers c").length, 1);
});

test("customer has no email on file — customer_email is not bound to a bogus value", async () => {
  const { vars } = await dispatch({
    customerContact: { email: null, phone: "+15551230000" },
    jobRecord: job({ appointments: [appointment({ id: 93, start: inDays(3) })] }),
  });

  assert.equal(vars.customer_email, undefined);
  assert.equal(vars.customer_phone, "+15551230000");
});

test("neither recipient nor customer name — customer_name is omitted rather than blank", async () => {
  const { vars } = await dispatch({
    row: { customer_name: null, recipient_name: null },
    jobRecord: job({ appointments: [appointment({ id: 94, start: inDays(3) })] }),
  });

  assert.equal(vars.customer_name, undefined);
});

// ── 7. Cross-cutting invariants ──────────────────────────────────────────────

test("every dynamic variable is a string and no ISO timestamp leaks", async () => {
  const { vars } = await dispatch({
    row: { job_date: new Date(inDays(3)), total_amount: 990, appointment_id: 11 },
    customerContact: { email: "ap@acme.test", phone: "+15551230000" },
    jobRecord: job({
      appointments: [
        appointment({ id: 11, start: inDays(3), end: inDays(3, 17), serviceLine: "Sprinkler", technicianName: "Dana Reed" }),
        appointment({ id: 12, start: inDays(-4), status: "completed" }),
      ],
    }),
  });

  assertRetellSafe(vars);
  assert.match(vars.next_appointment_date, /at \d{1,2}:\d{2}\s?(AM|PM)$/, "dates are in spoken form");
});

test("job-level context (job_number, comments) still rides along with the appointment context", async () => {
  const { vars } = await dispatch({
    comments: ["Gate code 4417", "Ask for Maria at the desk"],
    jobRecord: job({ jobNumber: "48767205", appointments: [appointment({ id: 95, start: inDays(3) })] }),
  });

  assert.equal(vars.job_number, "48767205");
  assert.ok(vars.job_comments.includes("Gate code 4417"));
});

test("pre-bound variables agree with what get_appointments would return for the same job", async () => {
  // The central risk of pre-binding: two sources for the same fact that can
  // disagree. At dispatch they are both derived from one jobCtx, and this pins
  // that — if someone changes one derivation, this fails.
  const jobRecord = job({
    appointments: [
      appointment({ id: 11, start: inDays(3), serviceLine: "Sprinkler", technicianName: "Dana Reed" }),
      appointment({ id: 12, start: inDays(20), customerConfirmed: true }),
      appointment({ id: 13, start: inDays(-8), status: "completed" }),
    ],
  });
  const { vars } = await dispatch({ jobRecord });

  const { buildJobConfirmationContext, toAppointmentsPayload } = require("../src/services/job-confirmation-context");
  const payload = toAppointmentsPayload(await buildJobConfirmationContext(9, 1, { tz: "America/New_York" }));

  assert.equal(vars.upcoming_count, String(payload.upcoming_count));
  assert.equal(vars.unconfirmed_count, String(payload.unconfirmed_count));
  assert.equal(vars.all_upcoming_confirmed, String(payload.all_upcoming_confirmed));
  assert.equal(vars.next_appointment_id, String(payload.next.appointment_id));
  assert.equal(vars.next_appointment_date, payload.next.scheduled_start_spoken);
  assert.equal(vars.next_service_line, payload.next.service_line);
  assert.equal(vars.next_technician, payload.next.technician || "");
  assert.equal(vars.upcoming_appointments.split("\n").length, payload.upcoming.length);
});

test("dispatch issues no extra queries for the pre-bound appointment facts", async () => {
  await dispatch({
    customerContact: { email: "ap@acme.test", phone: "+1555" },
    jobRecord: job({ appointments: manyAppointments(5) }),
  });

  // The whole point of computing from jobCtx: pre-binding must not add a
  // round trip to the dispatch path.
  assert.equal(fakeDb.matched("FROM appointment_technicians").length, 1);
  assert.equal(fakeDb.matched(/FROM appointments a/).length, 0, "context comes from the job read, not a second appointment query");
});

// ── Service detail and crew as dynamic variables ─────────────────────────────
//
// next_service_line and next_technician are the SHORT spoken forms used in the
// opening sentence. They deliberately drop detail, so on their own the agent
// could not answer "what are you actually doing?" or "who's coming?" without a
// tool round-trip — which is the latency this whole binding exists to avoid.
// These two variables carry the rest.

const svc = (name, description) => ({
  service_line_name: name, service_line_trade: "Fire Protection", description,
  status: "open", completion: null, estimated_price: null, duration: null,
});

test("next_appointment_services pairs each service line NAME with its description", async () => {
  const { vars } = await dispatch({
    jobRecord: job({ appointments: [appointment({
      id: 11, start: inDays(3),
      services: [
        svc("Backflow", "Annual Backflow Inspection (1-FL/2-Dom/Pool Mechanical Room)"),
        svc("Alarm Systems", "Annual Fire Alarm Inspection"),
      ],
    })] }),
  });

  const lines = vars.next_appointment_services.split("\n");
  assert.deepEqual(lines, [
    "Backflow — Annual Backflow Inspection (1-FL/2-Dom/Pool Mechanical Room)",
    "Alarm Systems — Annual Fire Alarm Inspection",
  ]);
  assert.ok(!/Fire Protection/.test(vars.next_appointment_services),
    "the trade repeats on every line for a fire contractor — noise, not information");
});

test("the rich detail survives in full while the spoken summary stays short", async () => {
  const long = "Annual Fire Sprinkler Inspection (1-Wet)(1-Dry)(1-BF) riser in the north stairwell";
  const { vars } = await dispatch({
    jobRecord: job({ appointments: [appointment({
      id: 11, start: inDays(3), services: [svc("Sprinkler", long)],
    })] }),
  });
  assert.ok(vars.next_appointment_services.includes(long), "detail must not be truncated");
  assert.equal(vars.next_service_line, "Sprinkler", "but the opening line says only the category");
  assert.ok(!vars.next_service_line.includes("1-Wet"), "'(1-Wet)(1-Dry)' must never reach the opening sentence");
});

test("next_technicians lists the whole crew with contact details", async () => {
  const { vars } = await dispatch({
    crew: [
      { appointment_id: 11, name: "Casey Nary", phone: null, email: "cnary@co.test" },
      { appointment_id: 11, name: "Jack Valentine", phone: "+15551234567", email: null },
    ],
    jobRecord: job({ appointments: [appointment({ id: 11, start: inDays(3), technicianName: "Casey Nary" })] }),
  });

  assert.deepEqual(vars.next_technicians.split("\n"), [
    "Casey Nary (cnary@co.test)",
    "Jack Valentine (+15551234567)",
  ]);
  assert.equal(vars.next_technician, "Casey Nary and Jack Valentine", "the spoken form is names only");
});

test("a technician with no contact details is still named, without empty brackets", async () => {
  const { vars } = await dispatch({
    crew: [{ appointment_id: 11, name: "No Contact", phone: null, email: null }],
    jobRecord: job({ appointments: [appointment({ id: 11, start: inDays(3) })] }),
  });
  assert.equal(vars.next_technicians, "No Contact");
  assert.ok(!vars.next_technicians.includes("()"));
});

test("no services and no crew → both variables are empty strings, not 'undefined'", async () => {
  const { vars } = await dispatch({
    jobRecord: job({ appointments: [appointment({ id: 11, start: inDays(3), serviceLine: null, technicianName: null })] }),
  });
  assert.equal(vars.next_appointment_services, "");
  assert.equal(vars.next_technicians, "");
  for (const v of Object.values(vars)) {
    assert.ok(!String(v).includes("undefined"), "a literal 'undefined' would be read aloud");
  }
});

test("the upcoming list carries the same paired detail, not just categories", async () => {
  const { vars } = await dispatch({
    jobRecord: job({ appointments: [appointment({
      id: 11, start: inDays(3), services: [svc("Backflow", "Annual Backflow Inspection")],
    })] }),
  });
  assert.match(vars.upcoming_appointments, /Backflow — Annual Backflow Inspection/);
});

test("every appointment variable the prompt reads is registered as a dynamic variable", async () => {
  const { vars } = await dispatch({
    jobRecord: job({ appointments: [appointment({ id: 11, start: inDays(3), services: [svc("Backflow", "x")] })] }),
  });
  // Guards the failure mode where Retell speaks a literal "{{next_technicians}}"
  // because the variable was bound at dispatch but never seeded.
  const seeded = new Set(require("../src/db/dynamic-variable-definitions").VARIABLE_SEEDS.map((v) => v.name));
  for (const k of ["next_appointment_services", "next_technicians", "next_service_line", "next_technician"]) {
    assert.ok(k in vars, `${k} must be bound at dispatch`);
    assert.ok(seeded.has(k), `${k} must be seeded, or a blank value renders as the literal placeholder`);
  }
});
