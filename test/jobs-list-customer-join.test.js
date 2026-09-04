/**
 * db/jobs.js's listJobs/getJobById customers join.
 *
 * It was an INNER join, which silently hid every job whose customer_id is
 * null. That is not an edge case: InspectPoint links work to a BUILDING and
 * its Account (our `customers`) is optional and usually absent, so a real
 * tenant's `GET /jobs` returned `{"jobs": [], "total": 0}` with 25 rows
 * sitting in the table. ServiceTrade was affected too, just invisibly — 12 of
 * its jobs have a null/dangling customer_id and were missing from every list
 * AND from the reported total.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const queries = [];
stub("db", {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/COUNT\(\*\)::int AS n/.test(sql)) return { rows: [{ n: 1 }] };
    if (/FROM jobs j/.test(sql)) {
      return { rows: [{ id: 1, company_id: 11, status: "pending", title: "Semi Annual Inspection", customer_id: null, customer_name: null }] };
    }
    return { rows: [] };
  },
});

const jobsDb = require("../src/db/jobs");

function reset() { queries.length = 0; }

test("listJobs joins customers with a LEFT join, so a job with no customer is still listed", async () => {
  reset();
  const result = await jobsDb.listJobs(11, { limit: 10 });
  const rowsQuery = queries.find((q) => /FROM jobs j/.test(q.sql) && !/COUNT/.test(q.sql));
  assert.match(rowsQuery.sql, /LEFT JOIN customers c ON c\.id = j\.customer_id/);
  assert.ok(
    !/(?<!LEFT )JOIN customers/.test(rowsQuery.sql),
    "an INNER join on customers drops every job whose customer_id is null"
  );
  assert.equal(result.rows.length, 1, "the customer-less job must come back");
  assert.equal(result.rows[0].customer_name, null, "and its customer fields are simply null");
});

test("the COUNT query uses the SAME join type, or `total` disagrees with the rows returned", async () => {
  reset();
  await jobsDb.listJobs(11, { limit: 10 });
  const countQuery = queries.find((q) => /COUNT\(\*\)::int AS n/.test(q.sql));
  assert.match(countQuery.sql, /LEFT JOIN customers c ON c\.id = j\.customer_id/);
  assert.ok(!/(?<!LEFT )JOIN customers/.test(countQuery.sql));
});

test("the customers join stays present in the COUNT query — `search` filters on c.full_name", async () => {
  reset();
  await jobsDb.listJobs(11, { search: "acme", limit: 10 });
  const countQuery = queries.find((q) => /COUNT\(\*\)::int AS n/.test(q.sql));
  assert.match(countQuery.sql, /customers c/, "dropping the join entirely would make a search count throw");
  assert.match(countQuery.sql, /c\.full_name ILIKE/);
});

test("getJobById also LEFT joins customers — an inner join 404'd a job that exists", async () => {
  reset();
  const job = await jobsDb.getJobById(1, 11);
  const q = queries.find((x) => /FROM jobs j/.test(x.sql));
  assert.match(q.sql, /LEFT JOIN customers c {2}ON c\.id = j\.customer_id/);
  assert.ok(job, "a customer-less job must be retrievable by id");
});
