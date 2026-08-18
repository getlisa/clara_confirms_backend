/**
 * db/confirmation-events.js — the ledger's SQL shape, and the one behaviour
 * that matters most: recordSafe never throws.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);

const queries = [];
let queryImpl = async () => ({ rows: [{ id: 1 }] });
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

const events = require("../src/db/confirmation-events");

function reset() { queries.length = 0; queryImpl = async () => ({ rows: [{ id: 1 }] }); logger.reset(); }
const find = (frag) => queries.find((q) => q.sql.includes(frag));

test("record writes every field, defaulting occurred_at to now()", async () => {
  reset();
  const id = await events.record({
    companyId: 8, eventType: "confirmed", channel: "chat", callType: "customer_confirmation",
    jobId: 900, appointmentId: 501, actorName: "Shivam Koli", source: "tok-abc",
  });
  assert.equal(id, 1);
  const q = find("INSERT INTO confirmation_events");
  assert.match(q.sql, /COALESCE\(\$2, now\(\)\)/, "occurred_at defaults to now() when not given");
  assert.deepEqual(q.params.slice(0, 3), [8, null, "confirmed"]);
});

test("details is always valid JSON, even when omitted", async () => {
  reset();
  await events.record({ companyId: 8, eventType: "cancelled", channel: "voice", source: "call-1" });
  const q = find("INSERT INTO confirmation_events");
  assert.equal(q.params[q.params.length - 2], "{}");
});

test("recordSafe swallows a failure and logs it — never throws", async () => {
  reset();
  queryImpl = async () => { throw new Error("table gone"); };
  const id = await events.recordSafe({ companyId: 8, eventType: "confirmed", channel: "chat", source: "tok" });
  assert.equal(id, null);
  assert.equal(logger.records.warn.length, 1);
});

test("listForRange scopes to company, is_test=false, and the given window", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await events.listForRange(8, { from: "2026-08-17T00:00:00Z", to: "2026-08-18T00:00:00Z" });
  const q = find("FROM confirmation_events");
  assert.match(q.sql, /company_id = \$1 AND is_test = false/);
  assert.match(q.sql, /occurred_at >= \$2 AND occurred_at < \$3/);
  assert.deepEqual(q.params, [8, "2026-08-17T00:00:00Z", "2026-08-18T00:00:00Z"]);
});

test("listForRange can additionally scope to one call_type", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await events.listForRange(8, { from: "a", to: "b", callType: "customer_confirmation" });
  const q = find("FROM confirmation_events");
  assert.match(q.sql, /AND call_type = \$4/);
  assert.deepEqual(q.params, [8, "a", "b", "customer_confirmation"]);
});

test("listForRange is ordered oldest first", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await events.listForRange(8, { from: "a", to: "b" });
  assert.match(find("FROM confirmation_events").sql, /ORDER BY occurred_at\s*$/);
});
