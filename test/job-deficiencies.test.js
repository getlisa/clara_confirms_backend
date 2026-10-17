/**
 * Structured deficiencies on GET /jobs/:id and the Refresh response
 * (docs/crm-sync-frontend.md §2a): every open deficiency at the job's site on
 * `job.deficiencies`, and per visit the ones that concern it, with why.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const future = new Date(Date.now() + 7 * 86400000);
const later = new Date(Date.now() + 30 * 86400000);
const past = new Date(Date.now() - 7 * 86400000);
let fixture;
const reset = () => {
  fixture = {
    appointments: [
      { id: 1, job_id: 7, status: "completed", scheduled_start: past },
      { id: 2, job_id: 7, status: "scheduled", scheduled_start: later },
      { id: 3, job_id: 7, status: "scheduled", scheduled_start: future },
    ],
    services: [{ appointment_id: 2, kind: "deficiency_repair", deficiency_id: 101, description: "Repair hood" }],
    deficiencies: [
      { id: 101, name: "Check micro switch — No", is_resolved: false, service_line_name: "Kitchen Hood", additional_information: {} },
      { id: 102, name: "Deficient - Street Side", status: "verified", is_resolved: false, service_line_name: "Sprinkler", additional_information: { severity: "deficient" } },
    ],
  };
};
const queries = [];
stub("db", {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM jobs j/.test(sql)) return { rows: [{ id: 7, company_id: 16, location_id: 40, title: "Annual" }] };
    if (/FROM appointments a/.test(sql)) return { rows: fixture.appointments };
    if (/FROM appointment_services aps/.test(sql)) return { rows: fixture.services };
    if (/FROM deficiencies d/.test(sql)) return { rows: fixture.deficiencies };
    return { rows: [] };
  },
});

const jobsDb = require("../src/db/jobs");

test("job.deficiencies lists every open deficiency at the site, structured, with the visits it concerns", async () => {
  reset();
  const job = await jobsDb.getJobById(7, 16, { withDeficiencies: true });
  assert.deepEqual(job.deficiency_summary, { open: 2 });
  const d102 = job.deficiencies.find((d) => d.id === 102);
  assert.equal(d102.name, "Deficient - Street Side");
  assert.equal(d102.severity, "deficient");
  assert.equal(d102.service_line, "Sprinkler");
  assert.equal(d102.is_resolved, false);
  assert.deepEqual(d102.visit_ids, [3], "open_at_site → the NEXT upcoming visit only");
  assert.deepEqual(job.deficiencies.find((d) => d.id === 101).visit_ids.sort(), [2, 3]);
  const q = queries.find((x) => /FROM deficiencies d/.test(x.sql));
  assert.match(q.sql, /is_resolved = false/);
  assert.deepEqual(q.params, [16, 7, 40], "the job's site (location) and the job itself");
});

test("each visit carries its deficiencies with a relation", async () => {
  reset();
  const job = await jobsDb.getJobById(7, 16, { withDeficiencies: true });
  const byId = Object.fromEntries(job.appointments.map((a) => [a.id, a.deficiencies]));
  assert.deepEqual(byId[1], [], "a past visit gets none");
  assert.deepEqual(byId[2].map((d) => [d.id, d.relation]), [[101, "repair_offered"]], "an InspectPoint repair offer on a later visit");
  assert.deepEqual(byId[3].map((d) => [d.id, d.relation]).sort(), [[101, "open_at_site"], [102, "open_at_site"]],
    "the next upcoming visit lists every open deficiency at the site — how ServiceTrade's reach a visit at all");
  assert.equal(byId[3][0].visit_ids, undefined, "visit_ids lives on job.deficiencies, not repeated per visit");
});

test("a visit that already carries a repair offer doesn't list the same deficiency twice", async () => {
  reset();
  fixture.services = [{ appointment_id: 3, kind: "deficiency_repair", deficiency_id: 101 }];
  const job = await jobsDb.getJobById(7, 16, { withDeficiencies: true });
  const next = job.appointments.find((a) => a.id === 3).deficiencies;
  assert.deepEqual(next.map((d) => [d.id, d.relation]), [[101, "repair_offered"], [102, "open_at_site"]]);
});

test("without the opt-in (the voice-dispatch path) no deficiency query runs and no fields are added", async () => {
  reset();
  queries.length = 0;
  const job = await jobsDb.getJobById(7, 16);
  assert.equal(queries.some((q) => /FROM deficiencies d/.test(q.sql)), false);
  assert.equal("deficiencies" in job, false);
  assert.equal("deficiencies" in job.appointments[0], false);
});
