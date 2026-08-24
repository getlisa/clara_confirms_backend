/**
 * End-to-end wiring for the custom sync window: HTTP query param → route →
 * crm-sync engine → CRM provider → runSync → the actual ServiceTrade /job
 * request.
 *
 * servicetrade-sync-range.test.js covers the two ends (route→engine.start, and
 * runSync's own behaviour) against stubs, which leaves the two links BETWEEN
 * them — engine→provider and provider→runSync — asserted only by reading the
 * code. That gap is exactly where a dropped param produces the symptom that
 * looks like nothing at all: a run that reports success with every count at
 * zero, because it quietly fell back to a default incremental sync whose cursor
 * matched nothing.
 *
 * So this file stubs ONLY the outermost edges — the HTTP client and the
 * database — and asserts on the real outbound query string. Everything between
 * the route and ServiceTrade is the production code path.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

// The engine's own run/event persistence — in memory, no database.
let seq = 0;
stub("engines/core/db", {
  createRun: async ({ kind, companyId }) => ({ id: 1, kind, company_id: companyId, started_at: new Date().toISOString() }),
  appendEvent: async (_id, evt) => ({ ...evt, seq: ++seq }),
  setStatus: async () => {},
  getRun: async () => ({ id: 1, status: "done", result: { jobs: 0 } }),
});

const stCalls = [];
stub("services/servicetrade", {
  request: async (_companyId, _method, path) => {
    stCalls.push(path);
    return path.startsWith("/job?")
      ? { ok: true, status: 200, data: { totalPages: 1, page: 1, jobs: [] }, messages: {} }
      : { ok: true, status: 200, data: { totalPages: 1, page: 1 }, messages: {} };
  },
});

stub("db/servicetrade-credentials", {
  getByCompanyId: async () => ({ username: "u", authCode: "PHPSESSID=x" }),
});

// A cursor IS set — a custom window must ignore it, and that is the whole
// difference between "synced the window" and "synced nothing".
stub("db/servicetrade-sync", new Proxy({
  getSyncState: async () => ({ last_jobs_updated_at: 1700000000 }),
  updateSyncState: async () => {},
}, { get: (t, p) => (p in t ? t[p] : async () => {}) }));

stub("auth/auth.middleware", {
  authenticate: (req, _res, next) => { req.user = { companyId: 8, id: 1 }; next(); },
});

const router = require("../src/routes/servicetrade");

let server, base;
test.before(async () => {
  const app = express();
  app.use("/integrations/servicetrade", router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/integrations/servicetrade`;
});
test.after(() => server.close());

/** POST /sync and wait for the background engine run to reach ServiceTrade. */
async function syncAndCaptureJobQuery(qs) {
  stCalls.length = 0;
  const res = await fetch(`${base}/sync${qs}`, { method: "POST" });
  const body = await res.json().catch(() => null);
  // The route's blocking path polls a stubbed getRun that returns immediately,
  // so give the detached run() a moment to actually issue its request.
  for (let i = 0; i < 100 && !stCalls.some((p) => p.startsWith("/job?")); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const jobCall = stCalls.find((p) => p.startsWith("/job?"));
  return { status: res.status, body, q: jobCall ? new URLSearchParams(jobCall.split("?")[1]) : null };
}

test("a custom window survives every link from query string to ServiceTrade", async () => {
  const { status, q } = await syncAndCaptureJobQuery("?startDate=2026-09-01&endDate=2026-09-30");
  assert.equal(status, 200);
  assert.ok(q, "the run never issued a /job request");

  // America/New_York in September → EDT (UTC-4). 1 Sep local midnight = 04:00Z.
  assert.equal(q.get("scheduleDateFrom"), String(Date.parse("2026-09-01T04:00:00Z") / 1000));
  assert.equal(q.get("scheduleDateTo"),   String(Date.parse("2026-10-01T03:59:59Z") / 1000));
  assert.equal(q.get("updatedAfter"), null,
    "a dropped window silently degrades to an incremental sync that matches nothing — " +
    "success with every count at zero, which is what this test exists to catch");
});

test("no window still produces the default incremental sync", async () => {
  const { q } = await syncAndCaptureJobQuery("");
  assert.ok(q);
  assert.equal(q.get("updatedAfter"), String(1700000000 - 300));
  const to = new Date(Number(q.get("scheduleDateTo")) * 1000);
  assert.equal(to.getUTCMonth(), new Date().getUTCMonth(), "current calendar month");
});
