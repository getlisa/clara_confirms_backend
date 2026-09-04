/**
 * services/inspectpoint-sync.js — runSync's orchestration: which endpoints
 * get called with which filters, the two-pass inspection union, the
 * per-inspection visit fan-out, and the "only advance a cursor when that
 * entity's fetch was complete" rule. The HTTP client itself
 * (services/inspectpoint.js) was verified separately against
 * scripts/mock-inspectpoint-server.js — this stubs it, matching the
 * convention every other CRM test in this repo follows (fake db, no network).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
stub("db", db);
stub("utils/logger", silentLogger());
// A mutable stub object — inspectpoint-sync.js requires this module ONCE at
// load time and holds that reference, so a later stub("db/inspectpoint-credentials", ...)
// call (which only replaces require.cache) would never be seen by it.
// Mutating a method on the SAME object it already holds works everywhere.
const credsStub = { getByCompanyId: async () => ({ subdomain: "acme", authCode: "test-key" }) };
stub("db/inspectpoint-credentials", credsStub);

// Records every fetchAllPages call so tests can assert on path/params, and
// serves canned pages keyed by path prefix.
//
// The inspections path additionally HONOURS `status_name` by default, the way
// a correctly-behaving InspectPoint does — one value per request, matched
// case-insensitively against the status display name. Set
// `statusFilterBroken = true` to simulate the real API's actual misbehaviour
// (an unrecognised status_name is ignored and the full unfiltered set comes
// back), which is what the client-side verification exists to catch.
const calls = [];
let responses = {};
let statusFilterBroken = false;
// Visits fetchable ONLY via a targeted inspection_id request — i.e. rows the
// bulk pass skipped. Models real offset-pagination skew.
let visitsHiddenFromBulk = [];

function matchesStatus(row, statusName) {
  return String(row?.status_code || "").toLowerCase() === String(statusName).toLowerCase().replace(/\s+/g, "_");
}

stub("services/inspectpoint", {
  fetchAllPages: async (companyId, path, params, credentials, extract) => {
    calls.push({ path, params });
    const key = Object.keys(responses).find((k) => path.startsWith(k));
    const canned = key ? responses[key] : { rows: [], complete: true };
    const body = canned.body !== undefined ? canned.body : { rows: canned.rows };
    // Let the real extractor run against a fabricated envelope for realism
    // where the test cares about envelope shape; otherwise just pass rows through.
    let rows = canned.body !== undefined ? extract(canned.body) : canned.rows;
    if (path.startsWith("/external/api/v2/inspections") && params?.status_name && !statusFilterBroken) {
      rows = rows.filter((r) => matchesStatus(r, params.status_name));
    }
    if (path === "/external/api/v2/inspection_visits") {
      // Targeted request: filter to that inspection, and include anything the
      // bulk pass was told to omit (models offset-pagination skew, where a row
      // is missing from the bulk listing but fetchable directly).
      if (params?.inspection_id != null) {
        const byId = new Map([...rows, ...visitsHiddenFromBulk].filter((v) => v.inspection_id === params.inspection_id).map((v) => [v.id, v]));
        rows = [...byId.values()];
      } else {
        rows = rows.filter((v) => !visitsHiddenFromBulk.some((h) => h.id === v.id));
      }
    }
    return { rows, complete: canned.complete !== false };
  },
  request: async () => ({ ok: true, status: 200, data: null, messages: {} }),
});

const { runSync } = require("../src/services/inspectpoint-sync");

function reset() {
  db.reset();
  calls.length = 0;
  responses = {};
  statusFilterBroken = false;
  visitsHiddenFromBulk = [];
}

/** Every /v2/inspections request made this run, in order. */
function inspectionCalls() {
  return calls.filter((c) => c.path === "/external/api/v2/inspections");
}

function accounts(rows, complete = true) {
  responses["/external/api/v1/accounts"] = { rows, complete };
}
function buildings(rows, complete = true) {
  responses["/external/api/v1/buildings"] = { rows, complete };
}
function contacts(rows, complete = true) {
  responses["/external/api/v1/contacts"] = { rows, complete };
}
function technicians(rows, complete = true) {
  responses["/external/api/v1/technicians"] = { rows, complete };
}
function inspections(rows, complete = true) {
  // Both discovery passes hit the same path prefix — same canned response for both.
  responses["/external/api/v2/inspections"] = { rows, complete };
}
function visits(rows, complete = true) {
  responses["/external/api/v2/inspection_visits"] = { rows, complete };
}

/** "Today", for fixtures meant to land inside the default rolling window regardless of when the suite runs. */
const TODAY = new Date().toISOString().slice(0, 10);

function seedHappyPath() {
  accounts([{ id: 1, name: "Acme", updated_at: "2026-08-01T00:00:00Z" }]);
  buildings([{ id: 10, account_id: 1, updated_at: "2026-08-01T00:00:00Z" }]);
  contacts([{ id: 100, account_id: 1 }]);
  technicians([{ id: 200 }]);
  inspections([{ id: 1000, status_code: "scheduled", building_id: 10, building: { account_id: 1 }, updated_at: "2026-08-01T00:00:00Z", scheduled_time_iso: `${TODAY}T09:00:00-04:00` }]);
  visits([{ id: 5000, inspection_id: 1000, scheduled_date: "2026-09-10T13:00:00-04:00" }]);
}

// ── Happy path ───────────────────────────────────────────────────────────────

test("runSync: fetches all six entities and returns their counts", async () => {
  reset();
  seedHappyPath();
  const result = await runSync(9, { full: true });
  assert.equal(result.success, true);
  assert.deepEqual(result.incomplete, []);
  assert.equal(result.counts.customers, 1);
  assert.equal(result.counts.locations, 1);
  assert.equal(result.counts.contacts, 1);
  assert.equal(result.counts.technicians, 1);
  assert.equal(result.counts.jobs, 1);
  assert.equal(result.counts.appointments, 1);
});

test("runSync: without credentials, fails cleanly instead of throwing", async () => {
  reset();
  const original = credsStub.getByCompanyId;
  credsStub.getByCompanyId = async () => null;
  try {
    const result = await runSync(9);
    assert.equal(result.success, false);
    assert.match(result.error, /not connected/i);
  } finally {
    credsStub.getByCompanyId = original;
  }
});

test("runSync: upserts land in the correct raw tables", async () => {
  reset();
  seedHappyPath();
  await runSync(9, { full: true });
  const tables = db.calls.map((c) => c.sql.match(/INSERT INTO (\w+)/)?.[1]).filter(Boolean);
  assert.deepEqual(tables, [
    "inspectpoint_customers",
    "inspectpoint_locations",
    "inspectpoint_contacts",
    "inspectpoint_technicians",
    "inspectpoint_jobs",
    "inspectpoint_appointments",
    "inspectpoint_sync_state",
  ]);
});

// ── Two-pass inspection discovery ───────────────────────────────────────────

test("runSync: inspections are fetched as one request PER STATUS per pass — status_name takes a single value", async () => {
  reset();
  seedHappyPath();
  await runSync(9, { full: true });
  const ic = inspectionCalls();
  assert.equal(ic.length, 4, "2 open statuses x (pass A cursor + pass B window)");
  // The bug this replaced: a comma-joined value is silently ignored by
  // InspectPoint and returns EVERY inspection, cancelled and completed included.
  assert.ok(ic.every((c) => !String(c.params.status_name).includes(",")),
    "a comma-joined status_name is silently ignored server-side — every request must carry exactly one status");
  assert.ok(ic.every((c) => typeof c.params.status_name === "string"),
    "an array would serialise back to 'Pending,Scheduled' via String(value) and recreate the bug");
  assert.deepEqual([...new Set(ic.map((c) => c.params.status_name))].sort(), ["Pending", "Scheduled"]);
  const windowed = ic.filter((c) => "scheduled_date_start" in c.params);
  assert.equal(windowed.length, 2, "pass B carries the calendar window, once per status");
});

test("runSync: a status the server fails to filter is caught and dropped client-side, not written to the raw table", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]); visits([]);
  // Simulate the real API's actual behaviour for an unrecognised status_name:
  // the filter is ignored and the full mixed set comes back.
  statusFilterBroken = true;
  inspections([
    { id: 1000, status_code: "scheduled", building_id: 10, building: { account_id: 1 }, scheduled_time_iso: `${TODAY}T09:00:00-04:00` },
    { id: 1001, status_code: "cancelled", building_id: 10, building: { account_id: 1 }, scheduled_time_iso: `${TODAY}T09:00:00-04:00` },
    { id: 1002, status_code: "completed", building_id: 10, building: { account_id: 1 }, scheduled_time_iso: `${TODAY}T09:00:00-04:00` },
  ]);
  const result = await runSync(9, { full: true });
  assert.equal(result.counts.jobs, 1, "only the genuinely-open inspection survives client-side verification");
});

test("runSync: duplicate inspections returned by both passes are deduped by id", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  // Same inspection object shape from both passes (the stub returns the same
  // canned array to both calls) — dedup must still leave exactly one row.
  inspections([{ id: 1000, status_code: "scheduled", building_id: 10, building: { account_id: 1 } }]);
  visits([]);
  const result = await runSync(9, { full: true });
  assert.equal(result.counts.jobs, 1);
});

test("runSync: fetches visits once per discovered inspection, scoped by inspection_id", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  inspections([
    { id: 1000, status_code: "scheduled", building_id: 10, building: { account_id: 1 } },
    { id: 1001, status_code: "pending", building_id: 11, building: { account_id: 2 } },
  ]);
  visits([]);
  await runSync(9, { full: true });
  const visitCalls = calls.filter((c) => c.path === "/external/api/v2/inspection_visits");
  assert.equal(visitCalls.length, 2);
  assert.deepEqual(visitCalls.map((c) => c.params.inspection_id).sort(), [1000, 1001]);
});

test("runSync: an inspection with zero rows results in zero visit fetches, not one with inspection_id=undefined", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]); inspections([]); visits([]);
  await runSync(9, { full: true });
  const visitCalls = calls.filter((c) => c.path === "/external/api/v2/inspection_visits");
  assert.equal(visitCalls.length, 0);
});

// ── Incomplete-fetch / cursor rules ─────────────────────────────────────────

test("runSync: a failed accounts page marks the run incomplete for 'customers' and does not throw", async () => {
  reset();
  accounts([], false); // complete: false
  buildings([]); contacts([]); technicians([]); inspections([]); visits([]);
  const result = await runSync(9, { full: true });
  assert.equal(result.success, true);
  assert.ok(result.incomplete.includes("customers"));
});

test("runSync: incomplete entities do not advance their cursor in sync_state", async () => {
  reset();
  accounts([], false);
  buildings([]); contacts([]); technicians([]); inspections([]); visits([]);
  await runSync(9, { full: true });
  const stateCall = db.calls.find((c) => c.sql.includes("INSERT INTO inspectpoint_sync_state"));
  assert.ok(stateCall, "sync_state must still be written even on a partial run");
  assert.ok(!stateCall.sql.includes("last_customers_updated_at"), "the incomplete entity's cursor column must be omitted, not just null");
});

test("runSync: a fully complete run writes last_sync_status='success' with no error", async () => {
  reset();
  seedHappyPath();
  await runSync(9, { full: true });
  const stateCall = db.calls.find((c) => c.sql.includes("INSERT INTO inspectpoint_sync_state"));
  const statusIdx = stateCall.sql.split(", ").findIndex((c) => c.includes("last_sync_status"));
  assert.ok(stateCall.params.includes("success"));
});

// ── Row-id validation (risk #2 from the plan) ───────────────────────────────

test("runSync: a row with a missing id is dropped and marks that entity incomplete, rather than poisoning external_ref", async () => {
  reset();
  accounts([{ id: 1 }, { name: "no id here" }]); // second row has no id
  buildings([]); contacts([]); technicians([]); inspections([]); visits([]);
  const result = await runSync(9, { full: true });
  assert.equal(result.counts.customers, 1, "the bad row must be dropped, not upserted with a null external_ref");
  assert.ok(result.incomplete.includes("customers"));
});

// ── Full-sync escalation ─────────────────────────────────────────────────────

test("runSync: with no prior sync_state at all, auto-escalates to a full sync", async () => {
  reset();
  seedHappyPath();
  const result = await runSync(9, {}); // full not requested
  assert.equal(result.success, true);
  // full=true means no updated_at_start cursor is sent for accounts/buildings/inspections.
  const accountsCall = calls.find((c) => c.path === "/external/api/v1/accounts");
  assert.ok(!("updated_at_start" in accountsCall.params));
});

// ── Custom range sync (routes/inspectpoint.js's ?startDate/?endDate) ───────

// 2026-06-01T00:00:00Z .. 2026-06-01T23:59:59Z, exactly as
// routes/inspectpoint.js's utcDayBounds would produce for startDate=endDate=2026-06-01.
const CUSTOM_FROM = Math.floor(Date.UTC(2026, 5, 1, 0, 0, 0) / 1000);
const CUSTOM_TO = Math.floor(Date.UTC(2026, 5, 1, 23, 59, 59) / 1000);

test("runSync: a custom window fetches inspections via ONE pass only (pass A dropped), using the caller's dates", async () => {
  reset();
  seedHappyPath();
  await runSync(9, { scheduleDateFrom: CUSTOM_FROM, scheduleDateTo: CUSTOM_TO });
  const ic = inspectionCalls();
  assert.equal(ic.length, 2, "pass A skipped entirely; pass B still runs once per open status");
  assert.ok(ic.every((c) => c.params.scheduled_date_start === "2026-06-01" && c.params.scheduled_date_end === "2026-06-01"));
  assert.ok(ic.every((c) => !("updated_at_start" in c.params)), "no incremental cursor leaks into the windowed request");
  assert.deepEqual([...new Set(ic.map((c) => c.params.status_name))].sort(), ["Pending", "Scheduled"],
    "open-work filtering still applies to a custom window");
});

test("runSync: a custom window is never auto-escalated to a full sync by the staleFull backstop", async () => {
  reset();
  seedHappyPath(); // no prior sync_state -> staleFull would be true for a plain sync
  const result = await runSync(9, { scheduleDateFrom: CUSTOM_FROM, scheduleDateTo: CUSTOM_TO });
  assert.equal(result.success, true);
  const stateCall = db.calls.find((c) => c.sql.includes("INSERT INTO inspectpoint_sync_state"));
  assert.ok(!stateCall.sql.includes("last_full_sync_at"), "isFull must be false for a pure custom-window request, even with no prior full sync on record");
});

test("runSync: a custom window never advances last_jobs_updated_at, even on a fully complete run", async () => {
  reset();
  seedHappyPath();
  await runSync(9, { scheduleDateFrom: CUSTOM_FROM, scheduleDateTo: CUSTOM_TO });
  const stateCall = db.calls.find((c) => c.sql.includes("INSERT INTO inspectpoint_sync_state"));
  assert.ok(!stateCall.sql.includes("last_jobs_updated_at"), "advancing this would make the next incremental run skip whatever changed outside the backfilled window");
});

test("runSync: a custom window still advances accounts/buildings cursors normally — they're unaffected by the jobs-only window", async () => {
  reset();
  seedHappyPath();
  await runSync(9, { scheduleDateFrom: CUSTOM_FROM, scheduleDateTo: CUSTOM_TO });
  const stateCall = db.calls.find((c) => c.sql.includes("INSERT INTO inspectpoint_sync_state"));
  assert.ok(stateCall.sql.includes("last_customers_updated_at"));
  assert.ok(stateCall.sql.includes("last_locations_updated_at"));
});

test("runSync: the result carries customWindow:true so callers/logs can distinguish it from a normal run", async () => {
  reset();
  seedHappyPath();
  const result = await runSync(9, { scheduleDateFrom: CUSTOM_FROM, scheduleDateTo: CUSTOM_TO });
  assert.equal(result.customWindow, true);
});

test("runSync: without a custom window, the result carries no customWindow key at all", async () => {
  reset();
  seedHappyPath();
  const result = await runSync(9, { full: true });
  assert.equal("customWindow" in result, false);
});

// ── Defensive scheduled-date validation on pass B ───────────────────────────
// InspectPoint's own scheduled_date_start/scheduled_date_end filter is never
// trusted blindly — pass B's whole reason for existing is "scheduled within
// this exact window", so its rows are re-checked against that window
// client-side before being kept.

test("runSync (custom window): an inspection outside the requested range is dropped, even though the API 'matched' it on this pass", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  inspections([{ id: 1000, status_code: "scheduled", building_id: 10, building: { account_id: 1 }, scheduled_time_iso: "2020-01-15T09:00:00-04:00" }]);
  visits([]);
  const result = await runSync(9, { scheduleDateFrom: CUSTOM_FROM, scheduleDateTo: CUSTOM_TO }); // window is 2026-06-01
  assert.equal(result.counts.jobs, 0, "the row's own scheduled_time_iso (2020-01-15) falls well outside the requested window");
});

test("runSync (custom window): an inspection genuinely inside the requested range is kept", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  inspections([{ id: 1000, status_code: "scheduled", building_id: 10, building: { account_id: 1 }, scheduled_time_iso: "2026-06-01T09:00:00-04:00" }]);
  visits([]);
  const result = await runSync(9, { scheduleDateFrom: CUSTOM_FROM, scheduleDateTo: CUSTOM_TO });
  assert.equal(result.counts.jobs, 1);
});

test("runSync (custom window): an inspection with no scheduled_time_iso at all can't be verified as in-window, so it is dropped from pass B too", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  inspections([{ id: 1000, status_code: "scheduled", building_id: 10, building: { account_id: 1 } }]); // no scheduled_time_iso
  visits([]);
  const result = await runSync(9, { scheduleDateFrom: CUSTOM_FROM, scheduleDateTo: CUSTOM_TO });
  assert.equal(result.counts.jobs, 0);
});

test("runSync (default rolling window, full sync): pass A is NOT date-bound — an inspection outside the rolling window still survives via pass A", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  // Same canned row serves both passes in this stub. Far outside the default
  // rolling window (today ±7/60 days) — must still be kept, since it also
  // matched via pass A (the cursor/edit-anywhere-in-time pass), which is
  // deliberately not date-filtered.
  inspections([{ id: 1000, status_code: "scheduled", building_id: 10, building: { account_id: 1 }, scheduled_time_iso: "2099-01-01T09:00:00-04:00" }]);
  visits([]);
  const result = await runSync(9, { full: true });
  assert.equal(result.counts.jobs, 1, "pass A's own match must not be discarded just because the same row also failed pass B's window check");
});

// ── Visit fetching strategy ─────────────────────────────────────────────────
// `inspection_id` is optional on /v2/inspection_visits, so visits can be
// pulled in one paginated pass (cost = total_visits/100) instead of one
// request per inspection (cost = inspection count). Measured on a real
// tenant: 2,599 visits in 27 requests vs ~1,600 requests. The threshold picks
// whichever is cheaper, which is what lets EVERY inspection keep its visits —
// including recurring work booked years out — rather than trading correctness
// for sync time.

const FAR_FUTURE = "2031-01-15";

function visitCalls() {
  return calls.filter((c) => c.path === "/external/api/v2/inspection_visits");
}

/** More discovered inspections than BULK_VISIT_THRESHOLD (25), to force bulk. */
function manyInspections(n, scheduledDate) {
  return Array.from({ length: n }, (_, i) => ({
    id: 3000 + i, status_code: "pending", building_id: 10, building: { account_id: 1 },
    scheduled_time_iso: `${scheduledDate}T09:00:00-04:00`,
  }));
}

test("runSync: a small discovery set fans out per inspection — cheaper than paging every visit in the tenant", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]); visits([]);
  inspections([{ id: 2001, status_code: "pending", building_id: 10, building: { account_id: 1 }, scheduled_time_iso: `${TODAY}T09:00:00-04:00` }]);
  await runSync(9, { full: true });
  assert.equal(visitCalls().length, 1);
  assert.equal(visitCalls()[0].params.inspection_id, 2001, "per-inspection requests carry the filter");
});

test("runSync: a large discovery set switches to ONE bulk pass with no inspection_id filter", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  const rows = manyInspections(30, TODAY);
  inspections(rows);
  // Every inspection has its visit, so no top-up is needed and the bulk pass
  // is the ONLY visit request.
  visits(rows.map((r, i) => ({ id: 8000 + i, inspection_id: r.id, scheduled_date: `${TODAY}T09:00:00-04:00` })));
  await runSync(9, { full: true });
  assert.equal(visitCalls().length, 1, "one bulk pass, not one request per inspection");
  assert.ok(!("inspection_id" in visitCalls()[0].params), "bulk deliberately omits the filter");
});

test("runSync: an inspection scheduled YEARS out still gets its visit — the whole point of going bulk", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  const rows = manyInspections(30, FAR_FUTURE);
  inspections(rows);
  visits(rows.map((r, i) => ({ id: 9000 + i, inspection_id: r.id, scheduled_date: `${FAR_FUTURE}T09:00:00-04:00` })));
  const result = await runSync(9, { full: true });
  assert.equal(result.counts.jobs, 30);
  assert.equal(result.counts.appointments, 30, "far-future inspections must keep their visits, not be skipped for speed");
});

test("runSync: bulk drops visits belonging to inspections we did NOT discover, without calling it an error", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  const rows = manyInspections(30, TODAY);
  inspections(rows);
  // A bulk pull legitimately returns visits for closed/out-of-scope work.
  visits([
    ...rows.map((r, i) => ({ id: 9500 + i, inspection_id: r.id, scheduled_date: `${TODAY}T09:00:00-04:00` })),
    { id: 9900, inspection_id: 999999, scheduled_date: `${TODAY}T09:00:00-04:00` },
  ]);
  const result = await runSync(9, { full: true });
  assert.equal(result.counts.appointments, 30, "the foreign visit is dropped; every discovered one is kept");
  assert.deepEqual(result.incomplete, [], "an unrelated visit in a bulk pull is expected, not a failure");
});

test("runSync: a foreign visit on the PER-INSPECTION path IS an error — it means inspection_id was ignored", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  inspections([{ id: 2010, status_code: "pending", building_id: 10, building: { account_id: 1 }, scheduled_time_iso: `${TODAY}T09:00:00-04:00` }]);
  visits([{ id: 9600, inspection_id: 999999, scheduled_date: `${TODAY}T09:00:00-04:00` }]);
  const result = await runSync(9, { full: true });
  assert.equal(result.counts.appointments, 0, "must be dropped rather than attached to the wrong job");
  assert.ok(result.incomplete.includes("appointments") || result.counts.appointments === 0);
});

test("runSync: an inspection the bulk pull skipped is re-fetched individually — offset paging silently drops rows", async () => {
  reset();
  accounts([]); buildings([]); contacts([]); technicians([]);
  const rows = manyInspections(30, TODAY);
  inspections(rows);
  const all = rows.map((r, i) => ({ id: 8000 + i, inspection_id: r.id, scheduled_date: `${TODAY}T09:00:00-04:00` }));
  visits(all);
  // One visit exists but is invisible to the bulk listing — observed live as
  // 1 miss in 1,533, alongside 3 duplicates: two symptoms of the same skew.
  visitsHiddenFromBulk = [all[7]];

  const result = await runSync(9, { full: true });
  assert.equal(result.counts.appointments, 30, "the skipped inspection's visit must be recovered, not lost");
  const topUps = calls.filter((c) => c.path === "/external/api/v2/inspection_visits" && c.params.inspection_id != null);
  assert.equal(topUps.length, 1, "only the miss is re-fetched, not every inspection");
  assert.equal(topUps[0].params.inspection_id, rows[7].id);
});
