/**
 * GET /jobs?sort=visit_date&order=asc|desc (docs/jobs-sort-backend-request.md).
 *
 * The Jobs table shows the ACTIVE APPOINTMENT's start as "Visit Date", so the
 * list must be ordered by that (`a.scheduled_start`), not jobs.scheduled_date,
 * which drifts from it after a reschedule. The list is paginated, so this has
 * to happen in SQL.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const queries = [];
stub("db", {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/COUNT\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 0 }] };
    return { rows: [] };
  },
});

const jobsDb = require("../src/db/jobs");

const orderBy = () => {
  const q = queries.find((x) => /FROM jobs j/.test(x.sql) && !/COUNT/.test(x.sql));
  // The LAST ORDER BY — the lateral subquery has its own (latest appointment).
  return [...q.sql.matchAll(/ORDER BY ([^\n]+)/g)].pop()[1].trim();
};

// order=asc / default: due soon first — upcoming soonest-first, then past
// most-recent-first, then no visit (docs/jobs-sort-backend-request.md).
const DUE_SOON = "(a.scheduled_start IS NULL), (a.scheduled_start < NOW()), CASE WHEN a.scheduled_start >= NOW() THEN a.scheduled_start END ASC, a.scheduled_start DESC, j.id ASC";

test.beforeEach(() => { queries.length = 0; });

test("default: due soon first — upcoming soonest, then past most recent, no visit last, id tiebreaker", async () => {
  await jobsDb.listJobs(16, {});
  assert.equal(orderBy(), DUE_SOON);
});

test("order=asc given explicitly is the same due-soon order as the default", async () => {
  await jobsDb.listJobs(16, { sort: "visit_date", order: "asc" });
  assert.equal(orderBy(), DUE_SOON);
});

test("order=desc: visit date decreasing — no-visit jobs still at the bottom", async () => {
  await jobsDb.listJobs(16, { sort: "visit_date", order: "desc" });
  assert.equal(orderBy(), "a.scheduled_start DESC NULLS LAST, j.id DESC");
});

test("order is case-insensitive", async () => {
  await jobsDb.listJobs(16, { order: "DESC" });
  assert.equal(orderBy(), "a.scheduled_start DESC NULLS LAST, j.id DESC");
});

test("unknown sort/order fall back to the default instead of failing", async () => {
  await jobsDb.listJobs(16, { sort: "priority", order: "sideways" });
  assert.equal(orderBy(), DUE_SOON);
});

test("the raw params are never interpolated into SQL", async () => {
  await jobsDb.listJobs(16, { sort: "j.id; DROP TABLE jobs", order: "desc; DROP TABLE jobs" });
  const sql = queries.map((q) => q.sql).join("\n");
  assert.doesNotMatch(sql, /DROP TABLE/);
  assert.equal(orderBy(), DUE_SOON);
});

test("sorting never touches the count query, so `total` is unaffected", async () => {
  await jobsDb.listJobs(16, { order: "desc" });
  const count = queries.find((q) => /COUNT\(\*\)::int AS n/.test(q.sql));
  assert.doesNotMatch(count.sql, /ORDER BY/);
});

test("it sorts on the same active appointment the table displays (latest non-cancelled/rescheduled)", async () => {
  await jobsDb.listJobs(16, {});
  const q = queries.find((x) => /FROM jobs j/.test(x.sql) && !/COUNT/.test(x.sql));
  assert.match(q.sql, /a\.scheduled_start AS active_appointment_start/);
  assert.match(q.sql, /ap\.status NOT IN \('cancelled','rescheduled'\)/);
});

// ── the route passes sort/order through ─────────────────────────────────────

test("GET /jobs forwards sort and order to listJobs", async () => {
  const calls = [];
  stub("db/jobs", { JOB_VIEWS: ["current", "past", "all"], listJobs: async (_c, opts) => { calls.push(opts); return { rows: [], total: 0 }; } });
  stub("auth", {
    authenticate: (req, _res, next) => { req.user = { userId: 1, companyId: 16, role: "admin" }; next(); },
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
    const base = `http://127.0.0.1:${server.address().port}/jobs`;
    assert.equal((await fetch(`${base}?sort=visit_date&order=desc`)).status, 200);
    assert.equal((await fetch(base)).status, 200);
  } finally {
    server.close();
  }
  assert.equal(calls[0].sort, "visit_date");
  assert.equal(calls[0].order, "desc");
  assert.equal(calls[1].sort, undefined, "absent params → listJobs defaults");
  assert.equal(calls[1].order, undefined);
});
