/**
 * db/slot-holds.js — the soft-hold primitives Phase 6's slot suggestion
 * builds on. Exercises the SQL shape and the "sweep expired holds inside the
 * same transaction as the insert" pattern, plus the exclusion-violation ->
 * {ok:false, conflict:true} translation, against a fake db/transaction
 * client (no real Postgres — the actual exclusion-constraint enforcement can
 * only be verified against real Postgres, which this suite doesn't run).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const queries = [];
const txQueries = [];
let insertResult = { rows: [{ id: 1, company_id: 7, technician_id: 42, starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T16:00:00.000Z", held_by_token: "tok", appointment_id: null, expires_at: "2026-06-01T13:10:00.000Z" }] };
let insertShouldConflict = false;
let deleteResult = { rows: [] };

stub("db", {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/^DELETE FROM slot_holds WHERE id/.test(sql) === false && /^DELETE FROM slot_holds/.test(sql)) {
      return deleteResult;
    }
    if (/^SELECT \* FROM slot_holds/.test(sql)) return { rows: [] };
    return { rows: [] };
  },
  transaction: async (callback) => {
    const client = {
      query: async (sql, params) => {
        txQueries.push({ sql, params });
        if (/^DELETE FROM slot_holds WHERE company_id = \$1 AND expires_at < NOW/.test(sql)) {
          return { rows: [] };
        }
        if (/^INSERT INTO slot_holds/.test(sql)) {
          if (insertShouldConflict) {
            const err = new Error("conflicting key value violates exclusion constraint");
            err.code = "23P01";
            throw err;
          }
          return insertResult;
        }
        return { rows: [] };
      },
    };
    return callback(client);
  },
});

const slotHoldsDb = require("../src/db/slot-holds");

function reset() {
  queries.length = 0;
  txQueries.length = 0;
  insertShouldConflict = false;
  deleteResult = { rows: [] };
}

test("hold() sweeps expired holds before inserting, in the SAME transaction", async () => {
  reset();
  await slotHoldsDb.hold({ companyId: 7, technicianId: 42, startsAt: "2026-06-01T14:00:00.000Z", endsAt: "2026-06-01T16:00:00.000Z", heldByToken: "tok" });
  assert.equal(txQueries.length, 2);
  assert.match(txQueries[0].sql, /DELETE FROM slot_holds WHERE company_id = \$1 AND expires_at < NOW/);
  assert.deepEqual(txQueries[0].params, [7]);
  assert.match(txQueries[1].sql, /INSERT INTO slot_holds/);
});

test("hold() returns {ok:true, hold} on success, with the inserted row's fields", async () => {
  reset();
  const result = await slotHoldsDb.hold({ companyId: 7, technicianId: 42, startsAt: "2026-06-01T14:00:00.000Z", endsAt: "2026-06-01T16:00:00.000Z", heldByToken: "tok" });
  assert.equal(result.ok, true);
  assert.equal(result.hold.id, 1);
  assert.equal(result.hold.technician_id, 42);
});

test("hold() defaults ttlMinutes to 10 when omitted", async () => {
  reset();
  await slotHoldsDb.hold({ companyId: 7, technicianId: 42, startsAt: "2026-06-01T14:00:00.000Z", endsAt: "2026-06-01T16:00:00.000Z", heldByToken: "tok" });
  const insert = txQueries.find((q) => /INSERT INTO slot_holds/.test(q.sql));
  assert.equal(insert.params[5], 10);
});

test("hold() translates a 23P01 exclusion violation into {ok:false, conflict:true} instead of throwing", async () => {
  reset();
  insertShouldConflict = true;
  const result = await slotHoldsDb.hold({ companyId: 7, technicianId: 42, startsAt: "2026-06-01T14:00:00.000Z", endsAt: "2026-06-01T16:00:00.000Z", heldByToken: "tok" });
  assert.deepEqual(result, { ok: false, conflict: true });
});

test("hold() re-throws any OTHER database error unchanged", async () => {
  reset();
  insertShouldConflict = false;
  const originalTransaction = require("../src/db").transaction;
  require("../src/db").transaction = async () => { throw new Error("connection lost"); };
  await assert.rejects(
    () => slotHoldsDb.hold({ companyId: 7, technicianId: 42, startsAt: "x", endsAt: "y", heldByToken: "tok" }),
    /connection lost/
  );
  require("../src/db").transaction = originalTransaction;
});

test("consumeByWindow() deletes matching a specific technician/window/token, only if unexpired", async () => {
  reset();
  deleteResult = { rows: [{ id: 5, company_id: 7, technician_id: 42, starts_at: "2026-06-01T14:00:00.000Z", ends_at: "2026-06-01T16:00:00.000Z", held_by_token: "tok", appointment_id: null, expires_at: "2026-06-01T13:10:00.000Z" }] };
  const result = await slotHoldsDb.consumeByWindow({ companyId: 7, technicianId: 42, startsAt: "2026-06-01T14:00:00.000Z", heldByToken: "tok" });
  assert.equal(result.id, 5);
  const del = queries.find((q) => /DELETE FROM slot_holds/.test(q.sql));
  assert.match(del.sql, /expires_at > NOW\(\)/);
  assert.deepEqual(del.params, [7, 42, "2026-06-01T14:00:00.000Z", "tok"]);
});

test("consumeByWindow() returns null (not an error) when nothing matches", async () => {
  reset();
  deleteResult = { rows: [] };
  const result = await slotHoldsDb.consumeByWindow({ companyId: 7, technicianId: 42, startsAt: "2026-06-01T14:00:00.000Z", heldByToken: "tok" });
  assert.equal(result, null);
});

test("releaseAllForToken() deletes every hold for that company+token", async () => {
  reset();
  await slotHoldsDb.releaseAllForToken({ companyId: 7, heldByToken: "tok" });
  const del = queries.find((q) => /DELETE FROM slot_holds WHERE company_id = \$1 AND held_by_token/.test(q.sql));
  assert.deepEqual(del.params, [7, "tok"]);
});

test("listActive() filters by technician, unexpired, and overlapping the given window", async () => {
  reset();
  await slotHoldsDb.listActive({ companyId: 7, technicianId: 42, from: "2026-06-01T00:00:00.000Z", to: "2026-06-02T00:00:00.000Z" });
  const sel = queries.find((q) => /SELECT \* FROM slot_holds/.test(q.sql));
  assert.match(sel.sql, /expires_at > NOW\(\)/);
  assert.match(sel.sql, /starts_at < \$4 AND ends_at > \$3/);
  assert.deepEqual(sel.params, [7, 42, "2026-06-01T00:00:00.000Z", "2026-06-02T00:00:00.000Z"]);
});

test("isSlotConflictError() recognizes 23P01 and only 23P01", () => {
  assert.equal(slotHoldsDb.isSlotConflictError({ code: "23P01" }), true);
  assert.equal(slotHoldsDb.isSlotConflictError({ code: "23505" }), false);
  assert.equal(slotHoldsDb.isSlotConflictError(new Error("plain")), false);
  assert.equal(slotHoldsDb.isSlotConflictError(null), false);
});
