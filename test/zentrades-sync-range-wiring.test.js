/**
 * End-to-end wiring for ZenTrades' custom sync window — the same gap
 * test/inspectpoint-sync-range-wiring.test.js exists to catch, on the third
 * CRM: HTTP query param -> route -> crm-sync engine -> CrmProvider.syncAll
 * -> zentrades-sync.js's runSync -> the actual outbound ticket-search
 * request body. zentrades-sync-engine.test.js already covers runSync's own
 * behavior against stubs; this covers the links BETWEEN the route and
 * runSync (engine->provider, provider->runSync) with real production code,
 * stubbing only the outermost edges (the HTTP client and the database).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

let seq = 0;
stub("engines/core/db", {
  createRun: async ({ kind, companyId }) => ({ id: 1, kind, company_id: companyId, started_at: new Date().toISOString() }),
  appendEvent: async (_id, evt) => ({ ...evt, seq: ++seq }),
  setStatus: async () => {},
  getRun: async () => ({ id: 1, status: "done", result: { tickets: 0 } }),
});

const ztCalls = [];
stub("services/zentrades", {
  fetchAllPages: async (_companyId, path, body) => {
    ztCalls.push({ path, body });
    return { rows: [], complete: true, count: 0 };
  },
  request: async () => ({ ok: true, status: 200, data: null }),
  // Never actually reached once the mutual-exclusion check refuses first —
  // stubbed anyway so a bug in that ordering fails loudly (an assertion
  // mismatch) instead of silently making a real network call in a test run.
  verifyCredentials: async () => ({ ok: false, message: "should not be called" }),
});

stub("db/zentrades-credentials", {
  getByCompanyId: async () => ({ authStatus: "ok", metadata: { zentradesCompanyId: 3 } }),
});

// Mutable stub objects, mutated in place rather than re-stubbed — routes/
// zentrades.js captures these exact object references via a top-level
// `require()` at load time, so replacing require.cache's entry later (what
// stub() does) would never be seen by code that already holds the old
// reference. See test/inspectpoint-sync-engine.test.js's credsStub comment
// for the same caveat.
const stCredsStub = { hasCredentials: async () => false };
const ipCredsStub = { hasCredentials: async () => false };
stub("db/servicetrade-credentials", stCredsStub);
stub("db/inspectpoint-credentials", ipCredsStub);

stub("auth/auth.middleware", {
  authenticate: (req, _res, next) => { req.user = { companyId: 8, id: 1 }; next(); },
});

const router = require("../src/routes/zentrades");

let server, base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/integrations/zentrades", router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/integrations/zentrades`;
});
test.after(() => server.close());

/** POST /sync and wait for the background engine run to reach ZenTrades. */
async function syncAndCapture(qs) {
  ztCalls.length = 0;
  const res = await fetch(`${base}/sync${qs}`, { method: "POST" });
  const body = await res.json().catch(() => null);
  for (let i = 0; i < 100 && ztCalls.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  return { status: res.status, body, ztCalls: [...ztCalls] };
}

test("a custom window reaches ZenTrades as day-boundary UTC instants, sliced into 7-day requests", async () => {
  const { status, ztCalls: calls } = await syncAndCapture("?startDate=2026-06-01&endDate=2026-06-14"); // 14 days, blocking (no stream=true)
  assert.equal(status, 200);
  assert.equal(calls.length, 2, "14 days / 7-day slices = 2 requests");
  const first = calls[0].body;
  assert.equal(first.gteDate[0].scheduledEndTime, new Date(Date.UTC(2026, 5, 1, 0, 0, 0)).toISOString());
  assert.equal(calls.at(-1).body.ltDate[0].scheduledStartTime, new Date(Date.UTC(2026, 5, 14, 23, 59, 59)).toISOString());
  // No server-side jobStatusId term — that id is per-tenant configuration
  // (company 12's sandbox tenant uses 1 for "Open", company 13's real one
  // uses 1988), so it can't be filtered on without already knowing this
  // specific tenant's mapping. Status filtering happens client-side instead,
  // on the tenant-portable string label — see services/zentrades-sync.js.
  assert.ok(calls.every((c) => Array.isArray(c.body.terms) && c.body.terms.length === 0), "no jobStatusId term is ever sent — that id is per-tenant, not a stable constant");
});

test("no window still produces the default rolling incremental slices", async () => {
  const { ztCalls: calls } = await syncAndCapture("");
  assert.equal(calls.length, 10, "ceil(67 / 7) = 10 slices for the default 7-back/60-forward window");
});

test("a malformed range never reaches the engine at all — 400 before any ZenTrades request", async () => {
  const res = await fetch(`${base}/sync?startDate=2026-02-30&endDate=2026-03-01`, { method: "POST" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Invalid date/i);
});

test("full=true combined with a range is rejected before any ZenTrades request", async () => {
  const res = await fetch(`${base}/sync?full=true&startDate=2026-06-01&endDate=2026-06-14`, { method: "POST" });
  assert.equal(res.status, 400);
});

test("POST /credentials refuses to connect while ServiceTrade is active", async () => {
  stCredsStub.hasCredentials = async () => true;
  const res = await fetch(`${base}/credentials`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "pw" }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /ServiceTrade is already connected/);
  stCredsStub.hasCredentials = async () => false; // restore for later tests
});

test("POST /credentials refuses to connect while InspectPoint is active", async () => {
  ipCredsStub.hasCredentials = async () => true;
  const res = await fetch(`${base}/credentials`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "alice", password: "pw" }),
  });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.match(body.error, /InspectPoint is already connected/);
  ipCredsStub.hasCredentials = async () => false;
});
