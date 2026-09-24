/**
 * services/zentrades-sync.js — runSync's orchestration: window resolution
 * (incremental/full/custom), slicing, client-side re-verification of every
 * server-side filter, decomposition of one ticket into six entity streams,
 * the conditional recurrence fan-out, and the "only advance a stamp when
 * complete" rule. The HTTP client (services/zentrades.js) is stubbed here,
 * matching the convention every other CRM test in this repo follows.
 *
 * The stub's fetchAllPages filters a seeded universe of "hits" by REAL
 * overlap-window logic (end >= gte && start < lt) rather than returning a
 * canned page — this lets tests seed one hit anywhere in a wide window and
 * trust it lands in the right slice(s), the same way the real API would
 * decide it, while still allowing individual tests to override `count`/
 * `complete` to simulate server misbehavior.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
stub("db", db);
stub("utils/logger", silentLogger());

const credsStub = { getByCompanyId: async () => ({ authStatus: "ok", metadata: { zentradesCompanyId: 3 } }) };
stub("db/zentrades-credentials", credsStub);

let seedHits = [];
let alwaysReturnHits = []; // returned regardless of window overlap — simulates a broken server-side filter
let countOverrideFor = null; // (gte, lt) => number|null — force a slice's reported `count`
let completeOverrideFor = null; // (gte, lt) => boolean|null
const fetchCalls = [];
const detailResponses = new Map(); // ticketId -> {ok, data}
const requestCalls = [];

stub("services/zentrades", {
  fetchAllPages: async (companyId, path, body) => {
    const gte = new Date(body.gteDate[0].scheduledEndTime);
    const lt = new Date(body.ltDate[0].scheduledStartTime);
    fetchCalls.push({ companyId, path, gte, lt, terms: body.terms });
    const overlapping = seedHits.filter((h) => {
      const start = new Date(h.scheduledStartTime);
      const end = new Date(h.scheduledEndTime);
      return end >= gte && start < lt;
    });
    const rows = [...overlapping, ...alwaysReturnHits];
    const complete = completeOverrideFor ? completeOverrideFor(gte, lt) : true;
    const count = countOverrideFor ? countOverrideFor(gte, lt) : rows.length;
    return { rows, complete, count };
  },
  request: async (companyId, method, path, opts) => {
    requestCalls.push({ companyId, method, path, opts });
    if (path === "/api/ticket") {
      const id = opts.query.id;
      return detailResponses.get(String(id)) || { ok: true, status: 200, data: { id, rruleDetails: null } };
    }
    return { ok: true, status: 200, data: null };
  },
});

const { runSync } = require("../src/services/zentrades-sync");

function reset() {
  db.reset();
  seedHits = [];
  alwaysReturnHits = [];
  countOverrideFor = null;
  completeOverrideFor = null;
  fetchCalls.length = 0;
  detailResponses.clear();
  requestCalls.length = 0;
  credsStub.getByCompanyId = async () => ({ authStatus: "ok", metadata: { zentradesCompanyId: 3 } });
}

/** A realistic hit shaped like api_doc/zentrades.md's sample ticket. */
function sampleTicket(overrides = {}) {
  const base = {
    id: 1924543,
    ticketNumber: "009670",
    scheduledStartTime: new Date().toISOString(),
    scheduledEndTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    jobStatusId: 1,
    jobStatus: "Open",
    customerId: 368,
    serviceAddressId: 418,
    companyId: 3,
    isActive: true,
    isDeleted: false,
    updatedAt: "2026-09-07T13:08:50.000Z",
    combinedFeatureFlag: undefined,
    assignments: [
      {
        id: 2790843, startTime: null, endTime: null, assignmentStatusId: 1, technicianId: 4705,
        recurringAssignmentId: 1788786528, isActive: true, isDeleted: false, status: "Open",
        assignmentStatusCFId: 2, statusCF: "Open: return trip needed", updatedAt: "2026-09-07T13:08:50.000Z",
        technician: { id: 4705, firstName: "1Ank", lastName: "ww", isActive: true, isDeleted: false, updatedAt: "2026-08-03T20:10:32.000Z" },
      },
      {
        id: 2790844, startTime: null, endTime: null, assignmentStatusId: 1, technicianId: 10697,
        recurringAssignmentId: 1788786529, isActive: true, isDeleted: false, status: "Open",
        assignmentStatusCFId: 2, statusCF: "Open: return trip needed", updatedAt: "2026-09-07T13:08:50.000Z",
        technician: { id: 10697, firstName: "20", lastName: "go 1", isActive: true, isDeleted: false, updatedAt: "2025-11-20T13:59:39.000Z" },
      },
    ],
    serviceAddress: {
      id: 418, customerId: 368, addressLine1: "2074 Steeles Avenue East1", isActive: true, isDeleted: false,
      doNotServe: false, email: "sandeep@smartserv.iooo", updatedAt: "2022-05-10T11:32:07.000Z",
      additionalContacts: [
        { id: 28, name: "abc", email: "abc@s.iooo", isActive: true, isDeleted: false, updatedAt: "2020-11-28T01:15:44.000Z" },
      ],
    },
    customer: {
      id: 368, displayName: "Nov Com12", email: "sandeep@smartserv.iooo", isActive: true, isDeleted: false,
      updatedAt: "2024-03-01T12:01:05.000Z",
      billingAddress: { id: 417, addressLine1: "2074 Steeles Avenue East2", additionalContacts: [{ id: 27, name: "abc", email: "abc@s.io" }] },
    },
    ...overrides,
  };
  for (const a of base.assignments) {
    a.startTime = a.startTime || base.scheduledStartTime;
    a.endTime = a.endTime || base.scheduledEndTime;
  }
  return base;
}

// ── connection / auth gating ─────────────────────────────────────────────

test("runSync refuses to run when ZenTrades isn't connected at all", async () => {
  reset();
  credsStub.getByCompanyId = async () => null;
  const result = await runSync(9);
  assert.equal(result.success, false);
  assert.match(result.error, /not connected/i);
  assert.equal(fetchCalls.length, 0);
});

test("runSync refuses to run while auth_status is not 'ok' — never hammers a known-bad password", async () => {
  reset();
  credsStub.getByCompanyId = async () => ({ authStatus: "invalid_credentials", metadata: {} });
  const result = await runSync(9);
  assert.equal(result.success, false);
  assert.match(result.error, /re-authentication required/);
  assert.equal(fetchCalls.length, 0);
});

// ── window resolution ────────────────────────────────────────────────────

test("incremental mode (no full, no custom range) slices a 67-day window (7 back + 60 forward) into 7-day chunks", async () => {
  reset();
  await runSync(9, {});
  assert.equal(fetchCalls.length, 10, "ceil(67/7) = 10 slices");
  // No server-side status term — jobStatusId is per-tenant configuration
  // (company 12's sandbox tenant uses 1 for "Open", company 13's real one
  // uses 1988), so a hardcoded numeric filter can't be correct across
  // tenants. Status filtering happens client-side on the string label.
  assert.ok(fetchCalls.every((c) => Array.isArray(c.terms) && c.terms.length === 0));
});

test("full mode widens the window to 90 back + 365 forward — many more slices than incremental", async () => {
  reset();
  await runSync(9, { full: true });
  assert.equal(fetchCalls.length, Math.ceil((90 + 365) / 7));
});

test("a custom range becomes exactly the slices needed to cover it, and is reported back as customWindow:true", async () => {
  reset();
  const from = Math.floor(Date.UTC(2026, 5, 1) / 1000); // 2026-06-01
  const to = Math.floor(Date.UTC(2026, 5, 15) / 1000);  // 2026-06-15 — 14 days
  const result = await runSync(9, { scheduleDateFrom: from, scheduleDateTo: to });
  assert.equal(result.customWindow, true);
  assert.equal(fetchCalls.length, 2, "14 days / 7-day slices = 2");
});

test("a custom range never advances any sync-state stamp, unlike a regular incremental run", async () => {
  reset();
  await runSync(9, { scheduleDateFrom: Math.floor(Date.now() / 1000), scheduleDateTo: Math.floor(Date.now() / 1000) + 86400 });
  const upsertCall = db.calls.find((c) => c.sql.startsWith("INSERT INTO zentrades_sync_state"));
  assert.ok(upsertCall, "sync state is still written (status/error), just not the per-entity stamps");
  assert.doesNotMatch(upsertCall.sql, /last_tickets_synced_at/);

  reset();
  await runSync(9, {}); // regular incremental run, nothing seeded but should still stamp on success
  const upsertCall2 = db.calls.find((c) => c.sql.startsWith("INSERT INTO zentrades_sync_state"));
  assert.match(upsertCall2.sql, /last_tickets_synced_at = \$/);
});

// ── decomposition ────────────────────────────────────────────────────────

test("one ticket decomposes into 1 ticket, 2 appointments, 1 customer, 1 location, 2 technicians, 3 contacts", async () => {
  reset();
  seedHits = [sampleTicket()];
  const result = await runSync(9, {});
  assert.equal(result.success, true);
  assert.deepEqual(result.counts, {
    tickets: 1, appointments: 2, customers: 1, locations: 1, technicians: 2, contacts: 3, recurrences: 0,
  });
});

test("assignment.startTime/endTime win over the ticket's own scheduledStartTime/EndTime on the appointment row", async () => {
  reset();
  const ticket = sampleTicket();
  const assignmentStart = new Date(Date.now() + 3600_000).toISOString();
  ticket.assignments[0].startTime = assignmentStart;
  seedHits = [ticket];
  await runSync(9, {});
  const insertSql = db.calls.find((c) => c.sql.startsWith("INSERT INTO zentrades_appointments"));
  assert.ok(insertSql.params.includes(assignmentStart), "the appointment row must carry the ASSIGNMENT's own start time");
});

test("billingAddress is stripped from the customer's stored payload", async () => {
  reset();
  seedHits = [sampleTicket()];
  await runSync(9, {});
  const insertSql = db.calls.find((c) => c.sql.startsWith("INSERT INTO zentrades_customers"));
  const payloadParam = insertSql.params.find((p) => typeof p === "string" && p.startsWith("{"));
  assert.equal(payloadParam.includes("billingAddress"), false);
});

test("do_not_serve is promoted onto the location row", async () => {
  reset();
  const ticket = sampleTicket();
  ticket.serviceAddress.doNotServe = true;
  seedHits = [ticket];
  await runSync(9, {});
  const insertSql = db.calls.find((c) => c.sql.startsWith("INSERT INTO zentrades_locations"));
  assert.ok(insertSql.params.includes(true), "do_not_serve=true must reach the raw row, not be buried in payload only");
});

test("a ticket missing serviceAddress or customer is thin data, not a fetch error — completeness is untouched", async () => {
  reset();
  const thin = sampleTicket({ id: 999, serviceAddress: undefined, customer: undefined, assignments: [] });
  seedHits = [thin];
  const result = await runSync(9, {});
  assert.equal(result.success, true);
  assert.deepEqual(result.incomplete, []);
  assert.equal(result.counts.tickets, 1);
  assert.equal(result.counts.locations, 0);
  assert.equal(result.counts.customers, 0);
});

// ── client-side re-verification ──────────────────────────────────────────

test("a hit outside the requested status is filtered client-side and does NOT mark the run incomplete", async () => {
  reset();
  seedHits = [sampleTicket({ jobStatusId: 2, jobStatus: "Completed" })];
  const result = await runSync(9, {});
  assert.equal(result.counts.tickets, 0, "the off-status ticket must be dropped");
  assert.deepEqual(result.incomplete, [], "a loose/misbehaving status filter doesn't mean OUR fetch was incomplete");
});

test("an Open ticket is kept regardless of its numeric jobStatusId — that id is per-tenant, not a stable constant (regression: company 13/Element Fire uses 1988 for 'Open', not 1)", async () => {
  reset();
  seedHits = [sampleTicket({ jobStatusId: 1988, jobStatus: "Open" })];
  const result = await runSync(9, {});
  assert.equal(result.counts.tickets, 1, "an Open ticket must sync regardless of this tenant's own numeric jobStatusId");
});

test("a hit outside the requested schedule window (server ignored the date filter) is dropped and does NOT mark incomplete", async () => {
  reset();
  const farAway = sampleTicket({
    id: 777,
    scheduledStartTime: new Date(Date.now() + 400 * 86400000).toISOString(),
    scheduledEndTime: new Date(Date.now() + 400 * 86400000 + 3600_000).toISOString(),
  });
  alwaysReturnHits = [farAway]; // simulates the server returning it regardless of the requested window
  const result = await runSync(9, {});
  assert.equal(result.counts.tickets, 0);
  assert.deepEqual(result.incomplete, []);
});

test("a hit whose companyId doesn't match this integration's tenant is dropped AND marks the run incomplete", async () => {
  reset();
  seedHits = [sampleTicket({ companyId: 999 })]; // credsStub says zentradesCompanyId: 3
  const result = await runSync(9, {});
  assert.equal(result.counts.tickets, 0);
  assert.deepEqual(result.incomplete, ["tickets"]);
});

test("a slice reporting more distinct ids than it returned marks the run incomplete (pagination omission)", async () => {
  reset();
  seedHits = [sampleTicket()];
  countOverrideFor = () => 5; // server claims 5 tickets exist in this slice; we only got 1
  const result = await runSync(9, {});
  assert.deepEqual(result.incomplete, ["tickets"]);
});

test("a failed slice fetch marks the run incomplete and does not advance sync-state stamps", async () => {
  reset();
  seedHits = [sampleTicket()];
  completeOverrideFor = (gte) => gte.getTime() !== new Date(0).getTime(); // force every slice to report incomplete
  completeOverrideFor = () => false;
  const result = await runSync(9, {});
  assert.deepEqual(result.incomplete, ["tickets"]);
  const upsertCall = db.calls.find((c) => c.sql.startsWith("INSERT INTO zentrades_sync_state"));
  assert.doesNotMatch(upsertCall.sql, /last_tickets_synced_at/);
});

// ── recurrence fan-out ───────────────────────────────────────────────────

test("only tickets with a non-empty combinedFeatureFlag trigger the recurrence detail fetch", async () => {
  reset();
  const recurring = sampleTicket({ id: 1, combinedFeatureFlag: "RECURRING_VISIT" });
  const oneOff = sampleTicket({ id: 2, combinedFeatureFlag: undefined, customer: { id: 500, updatedAt: null }, serviceAddress: { id: 501, customerId: 500, additionalContacts: [] } });
  seedHits = [recurring, oneOff];
  detailResponses.set("1", { ok: true, status: 200, data: { id: 1, rruleDetails: { id: 415914, rrule: "FREQ=WEEKLY", rruleString: "every day for 14 times", nthEvent: 8, moduleEntityId: "1" } } });
  const result = await runSync(9, {});
  assert.equal(result.counts.recurrences, 1);
  const ticketDetailCalls = requestCalls.filter((c) => c.path === "/api/ticket");
  assert.equal(ticketDetailCalls.length, 1);
  assert.equal(ticketDetailCalls[0].opts.query.id, 1);
});

test("a flagged ticket already covered by the fan-out cache (unchanged updatedAt) is skipped entirely", async () => {
  reset();
  const ticket = sampleTicket({ combinedFeatureFlag: "RECURRING_VISIT", updatedAt: "2026-09-07T13:08:50.000Z" });
  seedHits = [ticket];
  db.on("SELECT zentrades_ticket_id", [{ zentrades_ticket_id: String(ticket.id), zt_ticket_updated_at: "2026-09-07T13:08:50.000Z" }]);
  const result = await runSync(9, {});
  assert.equal(result.counts.recurrences, 0);
  assert.equal(requestCalls.filter((c) => c.path === "/api/ticket").length, 0, "the skip cache must prevent the detail fetch entirely");
});

test("a flagged ticket whose updatedAt CHANGED since the cache was written is re-fetched, not skipped", async () => {
  reset();
  const ticket = sampleTicket({ combinedFeatureFlag: "RECURRING_VISIT", updatedAt: "2026-09-08T00:00:00.000Z" });
  seedHits = [ticket];
  db.on("SELECT zentrades_ticket_id", [{ zentrades_ticket_id: String(ticket.id), zt_ticket_updated_at: "2026-09-07T00:00:00.000Z" }]); // stale
  detailResponses.set(String(ticket.id), { ok: true, status: 200, data: { id: ticket.id, rruleDetails: { id: 1, rrule: "x", moduleEntityId: String(ticket.id) } } });
  const result = await runSync(9, {});
  assert.equal(result.counts.recurrences, 1);
});

test("flag present but no rruleDetails on the detail response is counted, not treated as an error — completeness untouched", async () => {
  reset();
  const ticket = sampleTicket({ combinedFeatureFlag: "RECURRING_VISIT" });
  seedHits = [ticket];
  detailResponses.set(String(ticket.id), { ok: true, status: 200, data: { id: ticket.id, rruleDetails: null } });
  const result = await runSync(9, {});
  assert.equal(result.counts.recurrences, 0);
  assert.deepEqual(result.incomplete, []);
});

test("a detail response for a DIFFERENT ticket than requested is dropped and marks recurrences incomplete (foreign-row guard)", async () => {
  reset();
  const ticket = sampleTicket({ combinedFeatureFlag: "RECURRING_VISIT" });
  seedHits = [ticket];
  detailResponses.set(String(ticket.id), { ok: true, status: 200, data: { id: 99999999, rruleDetails: { id: 1, rrule: "x" } } });
  const result = await runSync(9, {});
  assert.equal(result.counts.recurrences, 0);
  assert.deepEqual(result.incomplete, ["recurrences"]);
});

test("rruleDetails.moduleEntityId not matching the requested ticket is dropped and marks recurrences incomplete", async () => {
  reset();
  const ticket = sampleTicket({ combinedFeatureFlag: "RECURRING_VISIT" });
  seedHits = [ticket];
  detailResponses.set(String(ticket.id), { ok: true, status: 200, data: { id: ticket.id, rruleDetails: { id: 1, rrule: "x", moduleEntityId: "wrong-ticket-id" } } });
  const result = await runSync(9, {});
  assert.equal(result.counts.recurrences, 0);
  assert.deepEqual(result.incomplete, ["recurrences"]);
});

// ── failure containment ──────────────────────────────────────────────────

test("a thrown error is caught, recorded as a failed sync state, and returned as success:false rather than propagating", async () => {
  reset();
  seedHits = [sampleTicket()];
  countOverrideFor = () => { throw new Error("boom"); };
  const result = await runSync(9, {});
  assert.equal(result.success, false);
  assert.match(result.error, /boom/);
  const upsertCall = db.calls.find((c) => c.sql.startsWith("INSERT INTO zentrades_sync_state"));
  assert.match(upsertCall.params[1] ?? "", /boom|failed/i);
});
