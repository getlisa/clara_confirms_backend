/**
 * Everything about a visit that the agent is allowed to say out loud:
 * ALL of its services, and ALL of its technicians.
 *
 * Both were previously "the first of" — `service_line` is literally
 * `services[0]`, and `technician` is the single `appointments.technician_id`
 * join. On real data that understated a visit badly: one appointment bundles
 * backflow + alarm + extinguisher + sprinkler and the agent named backflow
 * alone; 240 of 459 appointments have 2-4 technicians and the agent named one.
 *
 * Two layers are covered:
 *   - job-confirmation-context — derives the lists (fake db, no network)
 *   - prompt.build             — renders them (pure function, real thing)
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
stub("db", db);
stub("utils/logger", silentLogger());

const jobsDbStub = { getJobById: async () => null, fetchJobServiceLines: async () => [] };
stub("db/jobs", jobsDbStub);

const { buildJobConfirmationContext } = require("../src/services/job-confirmation-context");
const prompt = require("../src/confirmation-agent/graph/prompt");

// ── fixtures ─────────────────────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;
const future = () => new Date(Date.now() + 3 * DAY).toISOString();

function service(line, description) {
  return { service_line: line, description, status: "open", completion: null, estimated_price: null, duration: null };
}

/** Drive the real context builder over one appointment. */
async function ctxFor({ services = [], crew = [], technicianName = null, technicianPhone = null } = {}) {
  db.reset();
  db.on("FROM appointment_technicians", crew.map((c) => ({
    appointment_id: 1, name: c.name, phone: c.phone ?? null, email: c.email ?? null,
  })));
  db.on("FROM scheduling_comments", []);
  db.on("FROM job_notes", []);
  db.on("FROM job_comments", []);

  jobsDbStub.getJobById = async () => ({
    id: 10, job_number: "J-10", title: "Annual Inspection", description: null,
    job_type: "inspection", status: "scheduled", scheduled_date: null,
    customer: { full_name: "Acme", phone: null, email: null },
    technician: null,
    location_name: null,
    appointments: [{
      id: 1, job_id: 10, scheduled_start: future(), scheduled_end: null,
      status: "scheduled", customer_confirmed: false, technician_confirmed: false,
      technician_name: technicianName, technician_phone: technicianPhone,
      services, service_line: services[0]?.service_line ?? null,
    }],
  });

  const ctx = await buildJobConfirmationContext(9, 10, { tz: "America/Chicago" });
  assert.ok(ctx.ok, "context should build");
  return ctx;
}

const nextOf = (ctx) => ctx.appointments.upcoming[0];
const lineFor = (ctx) =>
  prompt.build({ ...ctx, phase: "confirming" }, { companyName: "Clara Fire" })
    .split("\n").find((l) => l.includes("#1"));

// ── Services ─────────────────────────────────────────────────────────────────

test("every service on the visit is exposed, not just the first", async () => {
  const ctx = await ctxFor({ services: [
    service("Backflow / Fire Protection", "Annual Backflow Inspection"),
    service("Alarm Systems / Fire Protection", "Annual Fire Alarm Inspection"),
    service("Sprinkler / Fire Protection", "Annual Fire Sprinkler Inspection"),
  ] });
  const a = nextOf(ctx);
  assert.equal(a.service_lines.length, 3);
  assert.equal(a.service_names.length, 3);
  assert.equal(a.service_line, "Backflow / Fire Protection", "the singular field stays first-of, for back-compat");
});

test("the chat prompt names all of them", async () => {
  const ctx = await ctxFor({ services: [
    service("Backflow / Fire Protection", "Annual Backflow Inspection"),
    service("Alarm Systems / Fire Protection", "Annual Fire Alarm Inspection"),
  ] });
  const line = lineFor(ctx);
  assert.match(line, /Annual Backflow Inspection/);
  assert.match(line, /Annual Fire Alarm Inspection/);
});

test("the spoken summary uses categories, never the raw descriptions", async () => {
  const ctx = await ctxFor({ services: [
    service("Sprinkler / Fire Protection", "Annual Fire Sprinkler Inspection (1-wet)(1-dry) (1 -bf)"),
  ] });
  const a = nextOf(ctx);
  assert.equal(a.service_summary, "Sprinkler", "trade suffix dropped, and '(1-wet)(1-dry)' must not reach an opening line");
  assert.ok(!/1-wet/.test(a.service_summary));
});

test("dispatcher notes wrapped in ** ** are stripped from what the agent says", async () => {
  const ctx = await ctxFor({ services: [
    service("Sprinkler / Fire Protection",
      "**MOVED TO AUG 2025 TO MAKE ON SAME SCHEDULE AS ALARM**\nAnnual Fire Sprinkler Inspection"),
  ] });
  const a = nextOf(ctx);
  assert.deepEqual(a.service_names, ["Annual Fire Sprinkler Inspection"]);
  assert.ok(!/MOVED TO AUG/.test(lineFor(ctx)), "an internal note read aloud is nonsense to a customer");
});

test("a description that is ONLY a note collapses away rather than becoming empty text", async () => {
  const ctx = await ctxFor({ services: [service("Backflow / Fire Protection", "**INTERNAL ONLY**")] });
  const a = nextOf(ctx);
  assert.deepEqual(a.service_names, [], "no empty-string service name");
  assert.deepEqual(a.service_lines, ["Backflow / Fire Protection"], "the category still identifies the work");
  assert.match(lineFor(ctx), /Backflow \/ Fire Protection/, "prompt falls back to the category");
});

test("duplicate service lines are not repeated to the customer", async () => {
  const ctx = await ctxFor({ services: [
    service("Sprinkler / Fire Protection", "Quarterly Sprinkler Inspection"),
    service("Sprinkler / Fire Protection", "Quarterly Sprinkler Inspection"),
  ] });
  const a = nextOf(ctx);
  assert.deepEqual(a.service_lines, ["Sprinkler / Fire Protection"]);
  assert.deepEqual(a.service_names, ["Quarterly Sprinkler Inspection"]);
});

test("an appointment with no services degrades cleanly", async () => {
  const ctx = await ctxFor({ services: [] });
  const a = nextOf(ctx);
  assert.deepEqual(a.service_lines, []);
  assert.deepEqual(a.service_names, []);
  assert.equal(a.service_summary, null, "null, not the string 'null' or an empty 'for ' clause");
  assert.ok(!/ for /.test(lineFor(ctx)), "no dangling 'for' with nothing after it");
});

// ── Technicians ──────────────────────────────────────────────────────────────

test("the whole crew is exposed, not just appointments.technician_id", async () => {
  const ctx = await ctxFor({
    technicianName: "Jack Valentine",
    crew: [{ name: "Jack Valentine" }, { name: "Dylan Colo" }, { name: "Casey Nary" }, { name: "Chris McAdams" }],
  });
  const a = nextOf(ctx);
  assert.equal(a.technician_names.length, 4);
  assert.equal(a.technician, "Jack Valentine", "the singular field stays the lead, for back-compat");
});

test("the chat prompt names the whole crew", async () => {
  const ctx = await ctxFor({
    technicianName: "Jack Valentine",
    crew: [{ name: "Jack Valentine" }, { name: "Dylan Colo" }],
  });
  const line = lineFor(ctx);
  assert.match(line, /with Jack Valentine, Dylan Colo/);
});

test("technician_summary reads as speech, not a comma-jammed list", async () => {
  const ctx = await ctxFor({ crew: [{ name: "A B" }, { name: "C D" }, { name: "E F" }] });
  assert.equal(nextOf(ctx).technician_summary, "A B, C D and E F");
});

test("one technician needs no 'and'", async () => {
  const ctx = await ctxFor({ crew: [{ name: "Solo Tech" }] });
  assert.equal(nextOf(ctx).technician_summary, "Solo Tech");
});

test("the same technician attached twice is named once", async () => {
  // A tech can be attached once per service line on the same visit.
  const ctx = await ctxFor({ crew: [
    { name: "Dana Twice", phone: "+15550000001" },
    { name: "Dana Twice", phone: "+15550000001" },
    { name: "Other One" },
  ] });
  const a = nextOf(ctx);
  assert.deepEqual(a.technician_names, ["Dana Twice", "Other One"]);
  // The objects list must be deduped too, not just the names: `technicians` is
  // what reaches the model through get_appointments, so a duplicate there is
  // visible to the agent even though the prompt line renders from the names.
  assert.equal(a.technicians.length, 2, "the crew list itself must not repeat a person");
  assert.deepEqual(a.technicians.map((t) => t.name), ["Dana Twice", "Other One"]);
  assert.equal((lineFor(ctx).match(/Dana Twice/g) || []).length, 1, "and never said twice to the customer");
});

test("empty crew falls back to the appointment's own technician", async () => {
  const ctx = await ctxFor({ technicianName: "Lone Ranger", technicianPhone: "+15550001111", crew: [] });
  const a = nextOf(ctx);
  assert.deepEqual(a.technician_names, ["Lone Ranger"]);
  assert.deepEqual(a.technicians, [{ name: "Lone Ranger", phone: "+15550001111", email: null }]);
  assert.match(lineFor(ctx), /with Lone Ranger/);
});

test("no technician anywhere → no 'with' clause at all", async () => {
  const ctx = await ctxFor({ technicianName: null, crew: [] });
  const a = nextOf(ctx);
  assert.deepEqual(a.technician_names, []);
  assert.equal(a.technician_summary, null);
  assert.ok(!/with /.test(lineFor(ctx)), "never render 'with null' or a trailing 'with'");
});

test("crew carries contact details, not just names", async () => {
  const ctx = await ctxFor({ crew: [{ name: "Dana Tech", phone: "+15559998888", email: "dana@co.test" }] });
  assert.deepEqual(nextOf(ctx).technicians, [{ name: "Dana Tech", phone: "+15559998888", email: "dana@co.test" }]);
});

test("crew order is stable — the DB read is explicitly ordered", async () => {
  await ctxFor({ crew: [{ name: "Zed" }] });
  const sql = db.calls.find((c) => c.sql.includes("FROM appointment_technicians")).sql;
  assert.match(sql, /ORDER BY at\.appointment_id, t\.first_name, t\.last_name, t\.id/,
    "unordered, a re-rendered prompt would look like the crew changed between turns");
});

// ── Both together, and the invariant that matters ────────────────────────────

test("a visit with several services AND several technicians reports both in full", async () => {
  const ctx = await ctxFor({
    services: [
      service("Backflow / Fire Protection", "Annual Backflow Inspection"),
      service("Alarm Systems / Fire Protection", "Annual Fire Alarm Inspection"),
    ],
    technicianName: "Lead Tech",
    crew: [{ name: "Lead Tech" }, { name: "Second Tech" }],
  });
  const line = lineFor(ctx);
  for (const expected of ["Annual Backflow Inspection", "Annual Fire Alarm Inspection", "Lead Tech", "Second Tech"]) {
    assert.ok(line.includes(expected), `prompt line should mention ${expected}`);
  }
});

test("past visits get the same detail as upcoming ones", async () => {
  db.reset();
  db.on("FROM appointment_technicians", [
    { appointment_id: 1, name: "Past Tech A", phone: null, email: null },
    { appointment_id: 1, name: "Past Tech B", phone: null, email: null },
  ]);
  db.on("FROM scheduling_comments", []); db.on("FROM job_notes", []); db.on("FROM job_comments", []);
  jobsDbStub.getJobById = async () => ({
    id: 10, job_number: "J-10", title: "Annual Inspection", description: null,
    job_type: "inspection", status: "completed", scheduled_date: null,
    customer: { full_name: "Acme" }, technician: null, location_name: null,
    appointments: [{
      id: 1, job_id: 10, scheduled_start: new Date(Date.now() - 5 * DAY).toISOString(),
      scheduled_end: null, status: "completed", customer_confirmed: true, technician_confirmed: false,
      technician_name: "Past Tech A", technician_phone: null,
      services: [service("Backflow / Fire Protection", "Annual Backflow Inspection")],
      service_line: "Backflow / Fire Protection",
    }],
  });
  const ctx = await buildJobConfirmationContext(9, 10, { tz: "America/Chicago" });
  assert.equal(ctx.appointments.history.length, 1);
  const line = prompt.build({ ...ctx, phase: "confirming" }, { companyName: "Clara Fire" })
    .split("\n").find((l) => l.includes("#1"));
  assert.match(line, /Annual Backflow Inspection/);
  assert.match(line, /Past Tech A, Past Tech B/);
  assert.match(line, /\(completed\)/, "history reports real status, not confirmed/not-confirmed");
});

test("nothing renders a literal null, undefined or [object Object]", async () => {
  const ctx = await ctxFor({
    services: [service(null, null), service("Backflow / Fire Protection", "Annual Backflow Inspection")],
    crew: [{ name: null }, { name: "Real Tech" }],
  });
  const out = prompt.build({ ...ctx, phase: "confirming" }, { companyName: "Clara Fire" });
  for (const bad of ["null", "undefined", "[object Object]", "NaN"]) {
    assert.ok(!out.includes(bad), `prompt must never contain a literal "${bad}"`);
  }
});
