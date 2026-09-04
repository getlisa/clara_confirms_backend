/**
 * db/inspectpoint-sync.js — the generic raw-table upsert and sync-state
 * read/write that all six inspectpoint_* raw tables share (unlike
 * ServiceTrade, which hand-writes one upsert per table). Fake db throughout;
 * asserts on the SQL actually issued, not just the return value, since a
 * malformed ON CONFLICT / column-count mismatch would only surface at
 * runtime against a real Postgres connection otherwise.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
stub("db", db);
stub("utils/logger", silentLogger());

const { getSyncState, updateSyncState, upsertRawBatch, listRaw } = require("../src/db/inspectpoint-sync");

function reset() {
  db.reset();
}

test("upsertRawBatch inserts every column in order — company_id, inspectpoint_id, extras, payload, ip_updated_at, updated_at", async () => {
  reset();
  await upsertRawBatch(
    "inspectpoint_jobs",
    ["inspectpoint_location_id", "status_code"],
    9,
    [{ inspectpointId: 1000, inspectpoint_location_id: 10, status_code: "scheduled", payload: { id: 1000 }, ipUpdatedAt: "2026-08-20T00:00:00Z" }]
  );
  const sql = db.sqls()[0];
  assert.match(sql, /INSERT INTO inspectpoint_jobs/);
  assert.match(sql, /\(company_id, inspectpoint_id, inspectpoint_location_id, status_code, payload, ip_updated_at, updated_at\)/);
  assert.match(sql, /ON CONFLICT \(company_id, inspectpoint_id\) DO UPDATE SET/);
  // Every extra column plus payload/ip_updated_at must be in the UPDATE SET — a
  // column silently missing there would mean re-syncing an existing row never
  // actually updates that field.
  assert.match(sql, /inspectpoint_location_id = EXCLUDED\.inspectpoint_location_id/);
  assert.match(sql, /status_code = EXCLUDED\.status_code/);
  assert.match(sql, /payload = EXCLUDED\.payload/);
  assert.match(sql, /ip_updated_at = EXCLUDED\.ip_updated_at/);
  assert.match(sql, /updated_at = NOW\(\)/);

  const params = db.calls[0].params;
  assert.deepEqual(params, [9, 1000, 10, "scheduled", JSON.stringify({ id: 1000 }), "2026-08-20T00:00:00Z"]);
});

test("upsertRawBatch defaults a missing extra column to null, never undefined", async () => {
  reset();
  await upsertRawBatch(
    "inspectpoint_appointments",
    ["inspectpoint_job_id", "inspectpoint_technician_id", "visit_status"],
    9,
    [{ inspectpointId: 5001, inspectpoint_job_id: 1001, payload: {}, ipUpdatedAt: null }]
  );
  const params = db.calls[0].params;
  // inspectpoint_technician_id and visit_status were never supplied on the row.
  assert.deepEqual(params, [9, 5001, 1001, null, null, "{}", null]);
});

test("upsertRawBatch chunks at the batch size and issues one query per chunk", async () => {
  reset();
  const rows = Array.from({ length: 5 }, (_, i) => ({ inspectpointId: i, payload: {}, ipUpdatedAt: null }));
  await upsertRawBatch("inspectpoint_customers", [], 1, rows, { batchSize: 2 });
  assert.equal(db.calls.length, 3); // 2 + 2 + 1
});

test("upsertRawBatch with an empty row array issues no query", async () => {
  reset();
  const n = await upsertRawBatch("inspectpoint_technicians", [], 1, []);
  assert.equal(n, 0);
  assert.equal(db.calls.length, 0);
});

test("getSyncState selects exactly the known sync-state columns", async () => {
  reset();
  db.on("FROM inspectpoint_sync_state", [{ last_sync_at: "2026-08-01T00:00:00Z", last_jobs_updated_at: "2026-08-01T00:00:00Z" }]);
  const state = await getSyncState(9);
  assert.equal(state.last_sync_at, "2026-08-01T00:00:00Z");
  const sql = db.sqls()[0];
  assert.match(sql, /last_customers_updated_at/);
  assert.match(sql, /last_contacts_synced_at/);
  assert.match(sql, /last_technicians_synced_at/);
  assert.match(sql, /last_normalized_at/);
  assert.match(sql, /WHERE company_id = \$1/);
});

test("getSyncState returns null for a company with no row yet", async () => {
  reset();
  const state = await getSyncState(999);
  assert.equal(state, null);
});

test("updateSyncState only writes known columns, dropping anything else silently", async () => {
  reset();
  await updateSyncState(9, { last_sync_status: "success", made_up_column: "x", last_jobs_updated_at: "2026-08-20T00:00:00Z" });
  const sql = db.sqls()[0];
  assert.match(sql, /INSERT INTO inspectpoint_sync_state/);
  assert.doesNotMatch(sql, /made_up_column/);
  assert.match(sql, /last_sync_status = \$/);
  assert.match(sql, /last_jobs_updated_at = \$/);
  assert.match(sql, /ON CONFLICT \(company_id\) DO UPDATE SET/);
});

test("updateSyncState drops undefined values — undefined means 'don't touch', matching the ServiceTrade convention", async () => {
  reset();
  await updateSyncState(9, { last_sync_status: "success", last_jobs_updated_at: undefined });
  const sql = db.sqls()[0];
  assert.doesNotMatch(sql, /last_jobs_updated_at/);
});

test("updateSyncState with nothing to write issues no query", async () => {
  reset();
  await updateSyncState(9, { made_up_column: "x" });
  assert.equal(db.calls.length, 0);
});

// ── listRaw ──────────────────────────────────────────────────────────────────

test("listRaw paginates with LIMIT/OFFSET derived from page/perPage", async () => {
  reset();
  db.on("SELECT * FROM inspectpoint_jobs", [{ id: 1 }, { id: 2 }]);
  db.on("SELECT COUNT(*)", [{ total: "37" }]);
  const { rows, total } = await listRaw("inspectpoint_jobs", 9, { page: 2, perPage: 10 });
  assert.equal(rows.length, 2);
  assert.equal(total, 37);
  const listSql = db.sqls().find((s) => s.startsWith("SELECT * FROM"));
  assert.match(listSql, /LIMIT \$2 OFFSET \$3/);
  assert.deepEqual(db.calls.find((c) => c.sql.startsWith("SELECT * FROM")).params, [9, 10, 10]); // page 2 -> offset 10
});

test("listRaw applies an optional filter column/value to both the list and count queries", async () => {
  reset();
  db.on("SELECT * FROM inspectpoint_locations", []);
  db.on("SELECT COUNT(*)", [{ total: "0" }]);
  await listRaw("inspectpoint_locations", 9, { filterColumn: "inspectpoint_customer_id", filterValue: 501 });
  const listCall = db.calls.find((c) => c.sql.startsWith("SELECT * FROM"));
  const countCall = db.calls.find((c) => c.sql.startsWith("SELECT COUNT(*)"));
  assert.match(listCall.sql, /AND inspectpoint_customer_id = \$2/);
  assert.deepEqual(listCall.params.slice(0, 2), [9, 501]);
  assert.match(countCall.sql, /AND inspectpoint_customer_id = \$2/);
  assert.deepEqual(countCall.params, [9, 501]);
});

test("listRaw with no filter omits the filter clause entirely from both queries", async () => {
  reset();
  db.on("SELECT * FROM inspectpoint_technicians", []);
  db.on("SELECT COUNT(*)", [{ total: "0" }]);
  await listRaw("inspectpoint_technicians", 9);
  const listCall = db.calls.find((c) => c.sql.startsWith("SELECT * FROM"));
  assert.doesNotMatch(listCall.sql, /AND/);
  assert.deepEqual(listCall.params, [9, 50, 0]); // default page 1, perPage 50
});

test("upsertRawBatch: duplicate ids from a paginated fetch are deduped before the statement is built", async () => {
  // Postgres rejects an INSERT ... ON CONFLICT whose VALUES names the same
  // conflict target twice ("cannot affect row a second time") and fails the
  // WHOLE batch. Every InspectPoint endpoint is offset-paginated over live
  // data, so a row shifting between pages really does come back twice — a real
  // bulk visit pull returned 2,599 rows for 2,596 distinct ids and took the
  // entire sync down with it.
  reset();
  const written = await upsertRawBatch("inspectpoint_appointments", ["visit_status"], 9, [
    { inspectpointId: 1, visit_status: "scheduled", payload: { v: "first" } },
    { inspectpointId: 2, visit_status: "scheduled", payload: { v: "other" } },
    { inspectpointId: 1, visit_status: "complete", payload: { v: "later page" } },
  ]);
  assert.equal(written, 2, "the duplicate must not be counted twice");
  const insert = db.calls.find((c) => /INSERT INTO inspectpoint_appointments/.test(c.sql));
  const idParams = insert.params.filter((_, i) => i % 5 === 1); // company_id, inspectpoint_id, visit_status, payload, ip_updated_at
  assert.deepEqual(idParams, [1, 2], "each conflict key appears exactly once in the VALUES list");
});

test("upsertRawBatch: the LAST occurrence wins, since later pages are read later", async () => {
  reset();
  await upsertRawBatch("inspectpoint_appointments", ["visit_status"], 9, [
    { inspectpointId: 1, visit_status: "scheduled", payload: { v: "stale" } },
    { inspectpointId: 1, visit_status: "complete", payload: { v: "fresh" } },
  ]);
  const insert = db.calls.find((c) => /INSERT INTO inspectpoint_appointments/.test(c.sql));
  assert.ok(insert.params.includes("complete"));
  assert.ok(!insert.params.includes("scheduled"));
});
