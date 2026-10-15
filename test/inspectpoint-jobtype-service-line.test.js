/**
 * For InspectPoint, the JOB TYPE is the service line (db/jobs.js
 * withJobTypeService). Since migration 111 InspectPoint visits carry a booked
 * service row with service_line NULL, so the agent had no service to name —
 * the opening fell back to the job title, onsite instructions (exact
 * service_line match) never matched, and getJobById could take a DEFICIENCY's
 * name as the visit's service line.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [] }) });

const { withJobTypeService } = require("../src/db/jobs");

const IP_JOB = { source: "inspectpoint", job_type: "Hood Cleaning Report", description: "Semi Annual Hood Cleaning Report inspection (about 4 hours)." };
const booked = (over = {}) => ({ kind: "service", service_line: null, service_line_name: null, description: "Semi Annual Hood Cleaning Report inspection (about 4 hours).", ...over });
const repair = (name) => ({ kind: "deficiency_repair", service_line: null, service_line_name: null, description: name, deficiency_id: 1 });

test("an InspectPoint booked service with no service line takes the job type", () => {
  const [s] = withJobTypeService(IP_JOB, [booked()]);
  assert.equal(s.service_line, "Hood Cleaning Report");
  assert.equal(s.service_line_name, "Hood Cleaning Report");
  assert.equal(s.derived_from, "job_type");
  assert.equal(s.description, "Semi Annual Hood Cleaning Report inspection (about 4 hours).", "its own description is kept");
});

test("a visit with no booked service gets one derived from the job, placed before deficiency repairs", () => {
  const out = withJobTypeService(IP_JOB, [repair("Bulb Gaskets — Fail")]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, "service");
  assert.equal(out[0].service_line, "Hood Cleaning Report");
  assert.equal(out[0].description, IP_JOB.description);
  assert.equal(out[1].kind, "deficiency_repair", "repairs stay, still partitioned out as offers downstream");
});

test("deficiency repair rows are never given the job type", () => {
  const out = withJobTypeService(IP_JOB, [booked(), repair("Caulking — Fail")]);
  assert.equal(out[1].service_line, null);
  assert.equal(out[1].derived_from, undefined);
});

test("an existing service line is left alone", () => {
  const [s] = withJobTypeService(IP_JOB, [booked({ service_line: "Kitchen Suppression", service_line_name: "Kitchen Suppression" })]);
  assert.equal(s.service_line, "Kitchen Suppression");
  assert.equal(s.derived_from, undefined);
});

test("ServiceTrade (and any non-InspectPoint) services are untouched", () => {
  const st = [booked({ service_line: null })];
  assert.equal(withJobTypeService({ ...IP_JOB, source: "servicetrade" }, st), st);
});

test("a blank job type changes nothing", () => {
  const svcs = [booked()];
  assert.equal(withJobTypeService({ ...IP_JOB, job_type: "   " }, svcs), svcs);
});

test("getJobById picks the visit's service line from BOOKED services, never a deficiency", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/db/jobs.js"), "utf8");
  assert.match(src, /appt\.services = withJobTypeService\(job, servicesByAppt\.get\(appt\.id\) \|\| \[\]\)/);
  assert.match(src, /appt\.service_line = appt\.services\.find\(\(s\) => \(s\.kind \|\| "service"\) === "service"\)\?\.service_line/);
});

test("call summaries list booked services only, with the job type for InspectPoint", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/conversation-summary.js"), "utf8");
  assert.match(src, /COALESCE\(s\.kind, 'service'\) = 'service'/);
  assert.match(src, /WHEN j\.source = 'inspectpoint' THEN NULLIF\(btrim\(j\.job_type\), ''\)/);
});
