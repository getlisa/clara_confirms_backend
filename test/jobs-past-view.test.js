/**
 * Past inspections are hidden from the default jobs list and live behind
 * GET /jobs?view=past, with counts at GET /jobs/views
 * (docs/crm-sync-strategy.md §7, docs/crm-sync-frontend.md §11).
 *
 * On a real InspectPoint tenant the list carried every inspection whose visit
 * had already happened alongside the ones that still need attention. Nothing
 * is deleted or moved — "past" is computed in the query, so a past job that is
 * rescheduled into the future reappears in the main list on its own.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const queries = [];
let rowsImpl = () => [];
stub("db", {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/COUNT\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 0 }] };
    if (/AS past,/.test(sql)) return { rows: [{ past: 80, total: 1670 }] };
    return { rows: rowsImpl() };
  },
});

const jobsDb = require("../src/db/jobs");

const rowsQuery = () => queries.find((q) => /FROM jobs j/.test(q.sql) && !/COUNT/.test(q.sql));
const countQuery = () => queries.find((q) => /COUNT\(\*\)::int AS n/.test(q.sql));
// The count query is the filter alone (no lateral, no ORDER BY), so its SQL is the WHERE under test.
const whereOf = (q) => q.sql;

test.beforeEach(() => { queries.length = 0; rowsImpl = () => []; });

// ── listJobs ────────────────────────────────────────────────────────────────

test("view=all (the db default, for every non-route caller) adds no past filter", async () => {
  await jobsDb.listJobs(11, { tz: "America/Chicago" });
  assert.doesNotMatch(whereOf(countQuery()), /pv\.job_id/);
});

test("view=past filters to jobs with no live visit today or later, in the company timezone", async () => {
  await jobsDb.listJobs(11, { tz: "America/Chicago", view: "past" });
  const where = whereOf(countQuery());
  assert.match(where, /\(NOT EXISTS \(SELECT 1 FROM appointments pv/);
  assert.doesNotMatch(where, /NOT \(NOT EXISTS/);
  assert.match(where, /pv\.status NOT IN \('cancelled','rescheduled'\)/,
    "a cancelled or superseded visit must not keep a job in the current list");
  assert.match(where, /DATE\(pv\.scheduled_start AT TIME ZONE \$2\) >= DATE\(NOW\(\) AT TIME ZONE \$2\)/,
    "local dates, so a visit this evening is still today");
  assert.equal(countQuery().params[1], "America/Chicago");
});

test("view=current is the exact negation of past, so the two lists partition every job", async () => {
  await jobsDb.listJobs(11, { tz: "America/Chicago", view: "current" });
  assert.match(whereOf(countQuery()), /NOT \(NOT EXISTS \(SELECT 1 FROM appointments pv/);
});

test("a job with no visit falls back to scheduled_date; one with no date at all is never past", async () => {
  await jobsDb.listJobs(11, { tz: "America/Chicago", view: "past" });
  assert.match(whereOf(countQuery()), /OR j\.scheduled_date < DATE\(NOW\(\) AT TIME ZONE \$2\)/);
});

test("the count and rows queries share the filter and parameters, so `total` matches the rows", async () => {
  await jobsDb.listJobs(11, { tz: "America/Chicago", view: "past", status: "pending" });
  const rq = rowsQuery(), cq = countQuery();
  assert.deepEqual(rq.params.slice(0, cq.params.length), cq.params);
});

test("every row carries is_past and last_visit_at (the latest live visit)", async () => {
  rowsImpl = () => [{ id: 1, company_id: 11, is_past: true, active_appointment_id: 9, active_appointment_start: "2026-04-29T11:00:00Z" }];
  const { rows } = await jobsDb.listJobs(11, { tz: "America/Chicago", view: "past" });
  assert.equal(rows[0].is_past, true);
  assert.equal(rows[0].last_visit_at, "2026-04-29T11:00:00Z");
  assert.match(rowsQuery().sql, / AS is_past/);
  // is_past has its own tz param after the WHERE params and before LIMIT/OFFSET.
  const p = rowsQuery().params;
  assert.equal(p[p.length - 3], "America/Chicago");
});

test("countJobViews returns current and past that add up to every job", async () => {
  const v = await jobsDb.countJobViews(11, { tz: "America/Chicago" });
  assert.deepEqual(v, { current: 1590, past: 80 });
});

// ── the route ──────────────────────────────────────────────────────────────

async function withApp(fn) {
  const calls = [];
  stub("db/jobs", {
    JOB_VIEWS: jobsDb.JOB_VIEWS,
    listJobs: async (_c, opts) => { calls.push(opts); return { rows: [], total: 0 }; },
    countJobViews: async () => ({ current: 1590, past: 80 }),
  });
  stub("auth", {
    authenticate: (req, _res, next) => { req.user = { userId: 1, companyId: 11, role: "admin" }; next(); },
    getCompanyId: (req) => req.user.companyId,
  });
  stub("utils/timezone", { getCompanyTimezone: async () => "America/Chicago", localToUTC: (x) => x, localizeFields: (o) => o, localizeRows: (r) => r });
  stub("services/job-confirmation-status", { syncJobConfirmationStatus: async () => {} });
  stub("services/scheduler", {});
  stub("db/call-settings", { getByCompanyId: async () => ({}) });
  delete require.cache[require.resolve("../src/routes/jobs")];
  const app = express();
  app.use("/jobs", require("../src/routes/jobs"));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}/jobs`, calls);
  } finally {
    server.close();
  }
}

test("GET /jobs hides past jobs by default; ?view=past and ?view=all are passed through", async () => {
  await withApp(async (base, calls) => {
    await fetch(base);
    await fetch(`${base}?view=past`);
    await fetch(`${base}?view=all`);
    await fetch(`${base}?view=garbage`);
    assert.deepEqual(calls.map((c) => c.view), ["current", "past", "all", "current"]);
  });
});

test("an explicit date range defaults to every job in it — a calendar of last week keeps working", async () => {
  await withApp(async (base, calls) => {
    await fetch(`${base}?scheduled_date_from=2026-10-05&scheduled_date_to=2026-10-11`);
    await fetch(`${base}?scheduled_date_from=2026-10-05&view=current`);
    assert.deepEqual(calls.map((c) => c.view), ["all", "current"]);
  });
});

test("GET /jobs/views returns the counts and is not swallowed by /jobs/:id", async () => {
  await withApp(async (base) => {
    const res = await fetch(`${base}/views`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { current: 1590, past: 80 });
  });
});
