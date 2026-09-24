/**
 * db/zentrades-sync.js — the generic raw-table upsert (all seven zentrades_*
 * tables) and sync-state read/write. Fake db throughout; asserts on the SQL
 * actually issued, not just the return value. The one thing this module has
 * that db/inspectpoint-sync.js doesn't: a configurable `conflictColumns`,
 * because zentrades_recurrences conflicts on zentrades_ticket_id rather than
 * zentrades_id (see migrations/108's header) — that's the highest-value
 * thing to pin here.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
stub("db", db);
stub("utils/logger", silentLogger());

const {
  getSyncState, updateSyncState, upsertRawBatch, listRaw,
  listOpenTicketIdsInWindow, getRecurrenceFanoutCache,
} = require("../src/db/zentrades-sync");

function reset() { db.reset(); }

// ── upsertRawBatch — default conflict (company_id, zentrades_id) ────────────

test("upsertRawBatch inserts every column in order and updates all of them on conflict", async () => {
  reset();
  await upsertRawBatch(
    "zentrades_tickets",
    ["job_status_id", "job_status"],
    9,
    [{ zentradesId: 1924543, job_status_id: 1, job_status: "Open", payload: { id: 1924543 }, ztUpdatedAt: "2026-09-07T13:08:50.000Z" }]
  );
  const sql = db.sqls()[0];
  assert.match(sql, /INSERT INTO zentrades_tickets/);
  assert.match(sql, /\(company_id, zentrades_id, job_status_id, job_status, payload, zt_updated_at, updated_at\)/);
  assert.match(sql, /ON CONFLICT \(company_id, zentrades_id\) DO UPDATE SET/);
  assert.match(sql, /job_status_id = EXCLUDED\.job_status_id/);
  assert.match(sql, /job_status = EXCLUDED\.job_status/);
  assert.match(sql, /payload = EXCLUDED\.payload/);
  assert.match(sql, /zt_updated_at = EXCLUDED\.zt_updated_at/);
  assert.match(sql, /updated_at = NOW\(\)/);

  assert.deepEqual(db.calls[0].params, [9, 1924543, 1, "Open", JSON.stringify({ id: 1924543 }), "2026-09-07T13:08:50.000Z"]);
});

test("upsertRawBatch defaults a missing extra column to null", async () => {
  reset();
  await upsertRawBatch("zentrades_appointments", ["zentrades_ticket_id", "assignment_status"], 9, [
    { zentradesId: 2790843, zentrades_ticket_id: 1924543, payload: {}, ztUpdatedAt: null },
  ]);
  assert.deepEqual(db.calls[0].params, [9, 2790843, 1924543, null, "{}", null]);
});

test("upsertRawBatch dedupes on the CONFLICT KEY before building the statement, last occurrence wins", async () => {
  reset();
  const rows = [
    { zentradesId: 1, payload: { v: "old" }, ztUpdatedAt: "2026-01-01T00:00:00Z" },
    { zentradesId: 1, payload: { v: "new" }, ztUpdatedAt: "2026-01-02T00:00:00Z" }, // same id, appeared twice (overlapping window slices)
    { zentradesId: 2, payload: {}, ztUpdatedAt: null },
  ];
  const count = await upsertRawBatch("zentrades_customers", [], 9, rows);
  assert.equal(count, 2, "the duplicate zentradesId:1 collapses to one row");
  const insertedPayloads = db.calls[0].params.filter((p) => typeof p === "string" && p.includes('"v"'));
  assert.deepEqual(insertedPayloads, [JSON.stringify({ v: "new" })], "the LATER occurrence must win, not the first");
});

test("upsertRawBatch chunks at the batch size and issues one query per chunk", async () => {
  reset();
  const rows = Array.from({ length: 5 }, (_, i) => ({ zentradesId: i, payload: {}, ztUpdatedAt: null }));
  await upsertRawBatch("zentrades_technicians", [], 1, rows, { batchSize: 2 });
  assert.equal(db.calls.length, 3); // 2 + 2 + 1
});

test("upsertRawBatch with an empty row array issues no query", async () => {
  reset();
  const n = await upsertRawBatch("zentrades_locations", [], 1, []);
  assert.equal(n, 0);
  assert.equal(db.calls.length, 0);
});

test("upsertRawBatch works with a TEXT zentradesId (zentrades_contacts' namespaced keys)", async () => {
  reset();
  await upsertRawBatch("zentrades_contacts", ["contact_kind"], 9, [
    { zentradesId: "cust:368", contact_kind: "customer", payload: {}, ztUpdatedAt: null },
  ]);
  assert.equal(db.calls[0].params[1], "cust:368");
});

// ── upsertRawBatch — the recurrences override: conflict on zentrades_ticket_id ──

test("upsertRawBatch honors a custom conflictColumns — zentrades_recurrences conflicts on zentrades_ticket_id, not zentrades_id", async () => {
  reset();
  await upsertRawBatch(
    "zentrades_recurrences",
    ["zentrades_ticket_id", "rrule"],
    9,
    [{ zentradesId: 415914, zentrades_ticket_id: 1924543, rrule: "FREQ=WEEKLY", payload: {}, ztUpdatedAt: null }],
    { conflictColumns: ["company_id", "zentrades_ticket_id"] }
  );
  const sql = db.sqls()[0];
  assert.match(sql, /ON CONFLICT \(company_id, zentrades_ticket_id\) DO UPDATE SET/);
  // zentrades_id is still a normal column, just not the conflict target.
  assert.match(sql, /\(company_id, zentrades_id, zentrades_ticket_id, rrule, payload, zt_updated_at, updated_at\)/);
});

test("dedupe for a custom conflictColumns keys on THAT column, not zentradesId — refetching the same ticket's recurrence twice collapses to one row even with different rruleDetails ids", async () => {
  reset();
  const rows = [
    { zentradesId: 111, zentrades_ticket_id: 500, payload: { v: "stale" }, ztUpdatedAt: null },
    { zentradesId: 222, zentrades_ticket_id: 500, payload: { v: "fresh" }, ztUpdatedAt: null }, // different rruleDetails.id, SAME ticket
  ];
  const count = await upsertRawBatch("zentrades_recurrences", ["zentrades_ticket_id"], 9, rows, { conflictColumns: ["company_id", "zentrades_ticket_id"] });
  assert.equal(count, 1, "both rows target the same conflict key (company_id, zentrades_ticket_id=500)");
});

// ── sync state ───────────────────────────────────────────────────────────────

test("getSyncState selects exactly the known columns, including the recurrence-specific ones", async () => {
  reset();
  db.on("FROM zentrades_sync_state", [{ last_sync_at: "2026-09-08T00:00:00Z" }]);
  const state = await getSyncState(9);
  assert.equal(state.last_sync_at, "2026-09-08T00:00:00Z");
  const sql = db.sqls()[0];
  assert.match(sql, /last_tickets_synced_at/);
  assert.match(sql, /last_recurrences_synced_at/);
  assert.match(sql, /last_pagination_mode/);
  assert.match(sql, /WHERE company_id = \$1/);
});

test("getSyncState returns null for a company with no row yet", async () => {
  reset();
  assert.equal(await getSyncState(999), null);
});

test("updateSyncState drops unknown columns and undefined values", async () => {
  reset();
  await updateSyncState(9, { last_sync_status: "success", made_up: "x", last_tickets_synced_at: undefined });
  const sql = db.sqls()[0];
  assert.doesNotMatch(sql, /made_up/);
  assert.doesNotMatch(sql, /last_tickets_synced_at/);
  assert.match(sql, /last_sync_status = \$/);
  assert.match(sql, /ON CONFLICT \(company_id\) DO UPDATE SET/);
});

test("updateSyncState with nothing to write issues no query", async () => {
  reset();
  await updateSyncState(9, { made_up: "x" });
  assert.equal(db.calls.length, 0);
});

// ── listOpenTicketIdsInWindow ────────────────────────────────────────────────

test("listOpenTicketIdsInWindow filters on the job_status STRING label (job_status_id is per-tenant, not a stable constant) and the same overlap predicate the API's own filter uses", async () => {
  reset();
  db.on("SELECT zentrades_id", [{ zentrades_id: "555" }]);
  const ids = await listOpenTicketIdsInWindow(9, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-08T00:00:00Z"));
  assert.deepEqual(ids, ["555"]);
  const sql = db.sqls()[0];
  assert.match(sql, /LOWER\(job_status\) = 'open'/);
  assert.doesNotMatch(sql, /job_status_id\s*=/, "must never filter on the numeric jobStatusId — it differs per tenant");
  assert.match(sql, /scheduled_end >= \$2 AND scheduled_start < \$3/);
});

// ── getRecurrenceFanoutCache ─────────────────────────────────────────────────

test("getRecurrenceFanoutCache returns a Map<ticketId, zt_ticket_updated_at>", async () => {
  reset();
  db.on("SELECT zentrades_ticket_id", [
    { zentrades_ticket_id: "1924543", zt_ticket_updated_at: "2026-09-07T13:08:50.000Z" },
    { zentrades_ticket_id: "1924544", zt_ticket_updated_at: "2026-09-06T00:00:00.000Z" },
  ]);
  const cache = await getRecurrenceFanoutCache(9);
  assert.equal(cache.get("1924543"), "2026-09-07T13:08:50.000Z");
  assert.equal(cache.size, 2);
});

// ── listRaw ──────────────────────────────────────────────────────────────────

test("listRaw paginates with LIMIT/OFFSET derived from page/perPage", async () => {
  reset();
  db.on("SELECT * FROM zentrades_tickets", [{ id: 1 }, { id: 2 }]);
  db.on("SELECT COUNT(*)", [{ total: "12" }]);
  const { rows, total } = await listRaw("zentrades_tickets", 9, { page: 2, perPage: 5 });
  assert.equal(rows.length, 2);
  assert.equal(total, 12);
  assert.deepEqual(db.calls.find((c) => c.sql.startsWith("SELECT * FROM")).params, [9, 5, 5]);
});
