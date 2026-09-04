/**
 * End-to-end wiring for InspectPoint's custom sync window — the same gap
 * test/servicetrade-sync-range-wiring.test.js exists to catch, on the other
 * CRM: HTTP query param → route → crm-sync engine → CrmProvider.syncAll →
 * inspectpoint-sync.js's runSync → the actual outbound /v2/inspections
 * request. inspectpoint-sync-engine.test.js already covers runSync's own
 * behavior against stubs; this covers the two links BETWEEN the route and
 * runSync (engine→provider, provider→runSync) with real production code,
 * stubbing only the outermost edges (the HTTP client and the database).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

let seq = 0;
stub("engines/core/db", {
  createRun: async ({ kind, companyId }) => ({ id: 1, kind, company_id: companyId, started_at: new Date().toISOString() }),
  appendEvent: async (_id, evt) => ({ ...evt, seq: ++seq }),
  setStatus: async () => {},
  getRun: async () => ({ id: 1, status: "done", result: { jobs: 0 } }),
});

const ipCalls = [];
stub("services/inspectpoint", {
  fetchAllPages: async (_companyId, path, params) => {
    ipCalls.push({ path, params });
    if (path === "/external/api/v2/inspections") return { rows: [], complete: true };
    return { rows: [], complete: true };
  },
  request: async () => ({ ok: true, status: 200, data: null }),
});

stub("db/inspectpoint-credentials", {
  getByCompanyId: async () => ({ subdomain: "acme", authCode: "test-key" }),
});

// A cursor IS set — a custom window must drop it entirely (pass A skipped),
// which is the whole difference between "synced the window" and "synced
// nothing" (a windowed request that also carries updated_at_start from a
// stale cursor would silently return near-empty results).
stub("db/inspectpoint-sync", new Proxy({
  getSyncState: async () => ({ last_jobs_updated_at: "2020-01-01T00:00:00.000Z", last_full_sync_at: new Date().toISOString() }),
  updateSyncState: async () => {},
}, { get: (t, p) => (p in t ? t[p] : async () => {}) }));

stub("auth/auth.middleware", {
  authenticate: (req, _res, next) => { req.user = { companyId: 8, id: 1 }; next(); },
});

const router = require("../src/routes/inspectpoint");

let server, base;
test.before(async () => {
  const app = express();
  app.use("/integrations/inspectpoint", router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/integrations/inspectpoint`;
});
test.after(() => server.close());

/** POST /sync and wait for the background engine run to reach InspectPoint. */
async function syncAndCaptureInspectionsCall(qs) {
  ipCalls.length = 0;
  const res = await fetch(`${base}/sync${qs}`, { method: "POST" });
  const body = await res.json().catch(() => null);
  for (let i = 0; i < 100 && !ipCalls.some((c) => c.path === "/external/api/v2/inspections"); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const inspectionCalls = ipCalls.filter((c) => c.path === "/external/api/v2/inspections");
  return { status: res.status, body, inspectionCalls };
}

test("a custom window survives every link from query string to InspectPoint, as ONE windowed request", async () => {
  const { status, inspectionCalls } = await syncAndCaptureInspectionsCall("?startDate=2026-06-01&endDate=2026-06-30");
  assert.equal(status, 200);
  // 2 = one request per open status (status_name takes a single value), pass B only.
  assert.equal(inspectionCalls.length, 2, "pass A must be dropped entirely for a custom window — only pass B's windowed requests should fire");
  assert.ok(inspectionCalls.every((c) => c.params.scheduled_date_start === "2026-06-01" && c.params.scheduled_date_end === "2026-06-30"));
  assert.ok(inspectionCalls.every((c) => !("updated_at_start" in c.params)),
    "a leaked stale cursor would silently return near-empty results — success with zero counts, which is what this test exists to catch");
});

test("no window still produces the default two-pass discovery", async () => {
  const { inspectionCalls } = await syncAndCaptureInspectionsCall("");
  // 4 = 2 open statuses x (pass A cursor + pass B rolling window).
  assert.equal(inspectionCalls.length, 4, "pass A (cursor) and pass B (rolling window) both fire, once per open status");
});

test("a malformed range never reaches the engine at all — 400 before any InspectPoint request", async () => {
  const res = await fetch(`${base}/sync?startDate=2026-02-30&endDate=2026-03-01`, { method: "POST" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Invalid date/i);
});

test("full=true combined with a range is rejected before any InspectPoint request", async () => {
  const res = await fetch(`${base}/sync?full=true&startDate=2026-06-01&endDate=2026-06-30`, { method: "POST" });
  assert.equal(res.status, 400);
});
