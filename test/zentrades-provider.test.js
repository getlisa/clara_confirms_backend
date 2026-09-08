/**
 * services/crm/zentrades/provider.js — the thin CrmProvider wrapper.
 * syncAll delegates raw fetch to runSync then calls normalizeAll (real
 * normalize logic is covered separately in test/zentrades-normalize.test.js
 * and test/zentrades-provider-normalize.test.js); every mirror method is
 * deliberately left at the CrmProvider base class's default (write-back is
 * explicitly out of scope, not an oversight — see this provider's own
 * header comment).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

// normalizeAll's own logic isn't under test here (see
// test/zentrades-provider-normalize.test.js for that) — every raw table is
// empty and every upsert/map lookup is a no-op, so normalizeAll resolves to
// all-zero counts. Higher-level methods (fetchAllByCompanyChunked etc.),
// not raw .query() — same shape test/inspectpoint-provider-normalize.test.js
// stubs for the same reason.
stub("db", {
  query: async () => ({ rows: [], rowCount: 0 }),
  fetchAllByCompanyChunked: async () => [],
  fetchExternalRefMap: async () => new Map(),
  bulkUpsertByExternalRef: async () => 0,
});

let runSyncArgs = null;
let runSyncResult = { success: true, counts: { tickets: 1 }, incomplete: [] };
stub("services/zentrades-sync", {
  runSync: async (companyId, opts) => { runSyncArgs = { companyId, opts }; return runSyncResult; },
});

const requestArgs = [];
stub("services/zentrades", {
  request: async (...args) => { requestArgs.push(args); return { ok: true, status: 200, data: null }; },
});

stub("db/zentrades-credentials", {
  getByCompanyId: async () => ({ authStatus: "ok" }),
});

const provider = require("../src/services/crm/zentrades/provider");
const { CrmProvider } = require("../src/services/crm/base");

test("the provider is a real CrmProvider instance with slug 'zentrades'", () => {
  assert.ok(provider instanceof CrmProvider);
  assert.equal(provider.slug, "zentrades");
});

test("syncAll delegates straight to runSync with the same options shape engines/crm-sync passes, then normalizes", async () => {
  const transitions = [];
  const engine = { transition: async (s) => transitions.push(s), emit: async () => {} };
  const result = await provider.syncAll(11, { full: true, engine, scheduleDateFrom: 1000, scheduleDateTo: 2000 });
  assert.deepEqual(runSyncArgs, { companyId: 11, opts: { full: true, engine, scheduleDateFrom: 1000, scheduleDateTo: 2000 } });
  assert.equal(result.ok, true);
  assert.equal(result.counts.tickets, 1, "raw counts are preserved alongside normalize's own");
  assert.deepEqual(result.counts.normalized, { customers: 0, contacts: 0, technicians: 0, locations: 0, jobs: 0, appointments: 0 });
  assert.ok(transitions.includes("normalizing"), "must transition through normalizing before finishing");
});

test("syncAll surfaces a runSync failure as {ok:false} without throwing", async () => {
  runSyncResult = { success: false, error: "ZenTrades not connected", counts: {} };
  const result = await provider.syncAll(11, {});
  assert.equal(result.ok, false);
  assert.equal(result.error, "ZenTrades not connected");
});

test("request() is a thin pass-through — no credentials object threaded through it (unlike InspectPoint's provider)", async () => {
  requestArgs.length = 0;
  await provider.request(11, "GET", "/api/ticket", { query: { id: 1 } });
  assert.deepEqual(requestArgs[0], [11, "GET", "/api/ticket", { query: { id: 1 } }]);
});

test("every write-back mirror is the CrmProvider default — not_supported, never throws", async () => {
  const skipped = { skipped: "not_supported" };
  assert.deepEqual(await provider.mirrorRescheduleAppointment(11, {}, {}), skipped);
  assert.deepEqual(await provider.mirrorCancelAppointment(11, {}, {}), skipped);
  assert.deepEqual(await provider.mirrorCancelJob(11, {}, {}), skipped);
  assert.deepEqual(await provider.mirrorCreateAppointment(11, {}, 1, {}), skipped);
  assert.deepEqual(await provider.mirrorRescheduleJob(11, {}, {}), skipped);
  assert.deepEqual(await provider.mirrorPostChatComment(11, {}), skipped);
  assert.deepEqual(await provider.mirrorPostCallComment(11, {}), skipped);
});
