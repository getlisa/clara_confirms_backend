/**
 * call-hydration.js's customers join and phone resolution.
 *
 * Two bugs, both surfaced by InspectPoint but neither InspectPoint-specific:
 *  1. An INNER join on customers made POST /calls/manual answer
 *     `404 "Job not found"` for a job that plainly exists — a job is not
 *     required to have a customer (InspectPoint links work to a BUILDING, and
 *     its Account is optional and usually absent).
 *  2. Even once found, the phone was read only from the customer record.
 *     InspectPoint Accounts carry NO phone at all, so every manual call would
 *     have failed missing_phone despite the SITE having a perfectly good
 *     number.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

let jobRow = null;
const queries = [];
stub("db", {
  query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: jobRow ? [jobRow] : [] };
  },
});

const { HYDRATORS } = require("../src/services/call-hydration");

const FUTURE = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

function reset(row) {
  queries.length = 0;
  jobRow = row;
}

test("open_job_due_soon: customers is LEFT joined — a customer-less job must not 404 as 'not found'", async () => {
  reset({ job_id: 1, job_status: "pending", job_name: "Semi Annual Inspection", scheduled_date: FUTURE, customer_phone: "+15551234567", customer_name: "Site A" });
  const r = await HYDRATORS.open_job_due_soon(11, 1);
  assert.equal(r.ok, true);
  const sql = queries[0].sql;
  assert.match(sql, /LEFT JOIN customers c ON c\.id = j\.customer_id/);
  assert.ok(!/(?<!LEFT )JOIN customers/.test(sql), "an INNER join reports a real job as missing");
});

test("open_job_due_soon: falls back to the SITE's phone and name when there is no customer record", async () => {
  // COALESCE happens in SQL, so the stub returns what the DB would produce.
  reset({ job_id: 1, job_status: "pending", job_name: "Inspection", scheduled_date: FUTURE, customer_phone: "+16104701382", customer_name: "Kennett Quick & Fresh Food" });
  const r = await HYDRATORS.open_job_due_soon(11, 1);
  assert.equal(r.params.phoneNumber, "+16104701382");
  assert.equal(r.params.customerName, "Kennett Quick & Fresh Food");
  assert.match(queries[0].sql, /COALESCE\(c\.phone, l\.phone\) AS customer_phone/);
  assert.match(queries[0].sql, /COALESCE\(c\.full_name, l\.name\) AS customer_name/);
  assert.match(queries[0].sql, /LEFT JOIN locations l ON l\.id = j\.location_id/);
});

test("open_job_due_soon: a genuinely missing job still 404s — the LEFT join must not mask that", async () => {
  reset(null);
  const r = await HYDRATORS.open_job_due_soon(11, 999999);
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test("open_job_due_soon: no phone anywhere hydrates fine and leaves phoneNumber null for the missing_phone gate", async () => {
  reset({ job_id: 1, job_status: "pending", job_name: "Inspection", scheduled_date: FUTURE, customer_phone: null, customer_name: "Dole Fresh Fruit" });
  const r = await HYDRATORS.open_job_due_soon(11, 1);
  assert.equal(r.ok, true, "the job exists; the gap is contact details, reported accurately downstream");
  assert.equal(r.params.phoneNumber, null);
});

test("scheduled_unconfirmed: same LEFT join and same site-phone fallback", async () => {
  reset({ appointment_id: 5, appointment_status: "scheduled", scheduled_start: new Date(Date.now() + 86400000).toISOString(), job_id: 1, job_status: "scheduled", job_name: "Inspection", customer_phone: "+16104701382", customer_name: "Site A" });
  const r = await HYDRATORS.scheduled_unconfirmed(11, 5);
  const sql = queries[0].sql;
  assert.match(sql, /LEFT JOIN customers c ON c\.id = j\.customer_id/);
  assert.match(sql, /COALESCE\(c\.phone, l\.phone\)/);
  assert.equal(r.ok, true);
});
