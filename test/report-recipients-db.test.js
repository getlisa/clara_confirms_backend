/**
 * db/report-recipients.js — CRUD + the sweep's read (listAllEnabledForSweep)
 * and its idempotency stamp (markSent).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const queries = [];
let queryImpl = async () => ({ rows: [] });
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

const recipients = require("../src/db/report-recipients");

function reset() { queries.length = 0; queryImpl = async () => ({ rows: [] }); }
const find = (frag) => queries.find((q) => q.sql.includes(frag));

test("create defaults to disabled — a new recipient must not fire before review", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ id: 1, company_id: 8, email: "a@x.test", enabled: false, send_at_local: "21:00:00", report_type: "daily_operations" }] });
  const r = await recipients.create({ companyId: 8, email: "A@X.test" });
  assert.equal(r.enabled, false);
  const q = find("INSERT INTO report_recipients");
  assert.equal(q.params[1], "a@x.test", "email is lowercased before it ever reaches the DB");
  assert.equal(q.params[6], false);
});

test("a duplicate (company, type, email) surfaces as a DUPLICATE-coded error", async () => {
  reset();
  queryImpl = async () => { const e = new Error("dup"); e.code = "23505"; throw e; };
  await assert.rejects(
    () => recipients.create({ companyId: 8, email: "a@x.test" }),
    (err) => err.code === "DUPLICATE"
  );
});

test("update touches only the fields given, and re-lowercases a changed email", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ id: 1, company_id: 8, email: "b@x.test", enabled: true, send_at_local: "09:00:00", report_type: "daily_operations" }] });
  await recipients.update(8, 1, { email: "B@X.test" });
  const q = find("UPDATE report_recipients SET");
  assert.ok(!q.sql.includes("send_at_local ="), "fields not passed must not be touched");
  assert.equal(q.params[2], "b@x.test");
});

test("send_at_local is exposed as HH:MM, not pg's HH:MM:SS", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ id: 1, company_id: 8, email: "a@x.test", enabled: true, send_at_local: "21:00:00", report_type: "daily_operations" }] });
  const r = await recipients.getById(8, 1);
  assert.equal(r.send_at_local, "21:00");
});

test("last_sent_for_date is normalized from pg's UTC-midnight Date to a plain string", async () => {
  reset();
  queryImpl = async () => ({ rows: [{
    id: 1, company_id: 8, email: "a@x.test", enabled: true, send_at_local: "21:00:00",
    report_type: "daily_operations", last_sent_for_date: new Date("2026-08-17T00:00:00.000Z"),
  }] });
  const r = await recipients.getById(8, 1);
  assert.equal(r.last_sent_for_date, "2026-08-17");
});

test("listAllEnabledForSweep joins the company timezone and business hours", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await recipients.listAllEnabledForSweep();
  const q = find("FROM report_recipients r");
  assert.match(q.sql, /r\.enabled = true/);
  assert.match(q.sql, /JOIN companies c ON c\.id = r\.company_id/);
  assert.match(q.sql, /LEFT JOIN call_settings cs/, "a company with no call_settings row must still be returned");
  assert.match(q.sql, /is_deleted IS NOT TRUE/);
});

test("markSent stamps the BUSINESS DATE, not today's date — the sweep's idempotency guard", async () => {
  reset();
  queryImpl = async () => ({ rowCount: 1 });
  await recipients.markSent(42, "2026-08-17");
  const q = find("UPDATE report_recipients SET last_sent_for_date");
  assert.deepEqual(q.params, [42, "2026-08-17"]);
});
