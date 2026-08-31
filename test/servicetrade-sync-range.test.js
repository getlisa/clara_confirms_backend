/**
 * Custom date-range sync — POST /integrations/servicetrade/sync
 * ?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD.
 *
 * Two halves, both guarding the same feature from opposite ends:
 *
 *   1. The engine. A custom window is a *windowed full* pull, not an
 *      incremental one. If the updatedAfter cursor survived alongside it, a
 *      backfill for July would ask ServiceTrade for "scheduled in July AND
 *      edited since yesterday" and come back with almost nothing — the feature
 *      would appear to work and silently sync no data. And afterwards the
 *      cursor must NOT advance: a July-only pass that stamps
 *      last_jobs_updated_at = now tells the next incremental run that every
 *      change up to this moment is handled, dropping every job outside the
 *      window that changed since the last real sync. Same invariant the
 *      targeted (webhook) path has, arrived at for the same reason.
 *
 *   2. The route. The 31-day cap and the YYYY-MM-DD parsing, including the
 *      company-timezone resolution — a range is a range of LOCAL days, so the
 *      epochs it produces have to move with DST.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
// No default_timezone row → utils/timezone falls back to America/New_York,
// which is what the DST assertions below are written against.
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

// ── Engine-side stubs (mirrors servicetrade-targeted-sync.test.js) ──────────

const stCalls = [];
let stImpl = async () => ({ ok: true, status: 200, data: {}, messages: {} });
stub("services/servicetrade", {
  request: async (companyId, method, path, opts) => {
    stCalls.push({ method, path });
    return stImpl(companyId, method, path, opts);
  },
});

stub("db/servicetrade-credentials", {
  getByCompanyId: async () => ({ username: "u", authCode: "PHPSESSID=x" }),
});

const stateWrites = [];
stub("db/servicetrade-sync", new Proxy({
  // A cursor is already set — the whole point is that a custom window ignores it.
  getSyncState: async () => ({ last_jobs_updated_at: 1700000000, last_appointments_updated_at: 1700000000 }),
  updateSyncState: async (companyId, fields) => { stateWrites.push({ companyId, fields }); },
}, {
  get: (target, prop) => (prop in target ? target[prop] : async () => {}),
}));

const stEngine = require("../src/services/servicetrade-sync");

function reset() {
  stCalls.length = 0;
  stateWrites.length = 0;
  stImpl = async (_c, _m, path) => path.startsWith("/job?")
    ? { ok: true, status: 200, data: { totalPages: 1, page: 1, jobs: [] }, messages: {} }
    : { ok: true, status: 200, data: { totalPages: 1, page: 1 }, messages: {} };
  logger.reset();
}

/** Query params of the one /job list call the run made. */
function jobListQuery() {
  const call = stCalls.find((c) => c.path.startsWith("/job?"));
  assert.ok(call, "expected a /job list call");
  return new URLSearchParams(call.path.split("?")[1]);
}

// ── buildJobParams — the window itself ──────────────────────────────────────

test("an explicit window replaces the current-month default", () => {
  const p = stEngine.buildJobParams({ scheduleDateFrom: 1751328000, scheduleDateTo: 1753999999 });
  assert.equal(p.scheduleDateFrom, "1751328000");
  assert.equal(p.scheduleDateTo, "1753999999");
});

test("no window still means the current calendar month, not a rolling 30 days", () => {
  const p = stEngine.buildJobParams({});
  const to = new Date(Number(p.scheduleDateTo) * 1000);
  const now = new Date();
  assert.equal(to.getUTCMonth(), now.getUTCMonth(), "must not spill into next month");
  assert.ok(Number(p.scheduleDateFrom) <= Math.floor(Date.now() / 1000));
});

test("full=true still overrides any window — it pulls every scheduled job", () => {
  const p = stEngine.buildJobParams({ full: true, scheduleDateFrom: 1751328000, scheduleDateTo: 1753999999 });
  assert.equal(p.scheduleDateFrom, undefined);
  assert.equal(p.scheduleDateTo, undefined);
});

// ── runSync — cursor semantics ──────────────────────────────────────────────

test("a custom window drops the updatedAfter cursor", async () => {
  reset();
  await stEngine.runSync(8, { scheduleDateFrom: 1751328000, scheduleDateTo: 1753999999 });

  const q = jobListQuery();
  assert.equal(q.get("scheduleDateFrom"), "1751328000");
  assert.equal(q.get("scheduleDateTo"), "1753999999");
  assert.equal(q.get("updatedAfter"), null,
    "with the cursor still applied, a backfill of a past month returns nothing at all");
});

test("a custom-window run advances no cursor and does not claim a fresh last_sync_at", async () => {
  reset();
  const out = await stEngine.runSync(8, { scheduleDateFrom: 1751328000, scheduleDateTo: 1753999999 });

  assert.equal(out.success, true);
  assert.equal(out.customWindow, true);
  const fields = stateWrites.at(-1)?.fields || {};
  assert.equal(fields.last_jobs_updated_at, undefined,
    "advancing this would make the next incremental run skip every job outside the window");
  assert.equal(fields.last_appointments_updated_at, undefined);
  assert.equal(fields.last_sync_at, undefined,
    "the UI reads last_sync_at as 'everything is up to date' — a one-month backfill did not earn that");
  assert.equal(fields.last_sync_status, "success", "the outcome is still worth recording");
});

test("a one-sided window is enough to count as custom", async () => {
  reset();
  await stEngine.runSync(8, { scheduleDateFrom: 1751328000 });
  assert.equal(jobListQuery().get("updatedAfter"), null);
});

test("a normal run is untouched — month window plus the incremental cursor", async () => {
  reset();
  const out = await stEngine.runSync(8, {});

  const q = jobListQuery();
  assert.ok(q.get("scheduleDateFrom"), "the default month window still applies");
  assert.equal(q.get("updatedAfter"), String(1700000000 - 300),
    "the 2-hourly cron must stay incremental");
  assert.equal(out.customWindow, undefined);
  assert.ok(stateWrites.at(-1).fields.last_sync_at, "and its cursors must keep moving");
});

// ── Route — validation and timezone resolution ──────────────────────────────

const startCalls = [];
stub("engines/crm-sync", {
  start: async (opts) => { startCalls.push(opts); return { id: 42, kind: "crm_sync" }; },
});
stub("engines/core/db", { getRun: async () => ({ status: "done", result: { jobs: 3 } }) });
stub("auth/auth.middleware", {
  authenticate: (req, _res, next) => { req.user = { companyId: 8, id: 1 }; next(); },
});

const router = require("../src/routes/servicetrade");

let server, base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/integrations/servicetrade", router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/integrations/servicetrade`;
});
test.after(() => server.close());

async function sync(qs) {
  const r = await fetch(`${base}/sync${qs}`, { method: "POST" });
  return [r.status, await r.json().catch(() => null)];
}

test("a valid range reaches the engine as company-local epoch seconds", async () => {
  startCalls.length = 0;
  const [status] = await sync("?startDate=2026-07-01&endDate=2026-07-31");
  assert.equal(status, 200);

  const { scheduleDateFrom, scheduleDateTo } = startCalls[0];
  // America/New_York, July → EDT (UTC-4). Midnight local is 04:00Z.
  assert.equal(new Date(scheduleDateFrom * 1000).toISOString(), "2026-07-01T04:00:00.000Z");
  assert.equal(new Date(scheduleDateTo * 1000).toISOString(), "2026-08-01T03:59:59.000Z",
    "endDate is inclusive — through 23:59:59 on the 31st, local");
});

test("the same range in winter lands an hour later in UTC — the days are LOCAL days", async () => {
  startCalls.length = 0;
  await sync("?startDate=2026-01-01&endDate=2026-01-31");
  // EST (UTC-5).
  assert.equal(new Date(startCalls[0].scheduleDateFrom * 1000).toISOString(), "2026-01-01T05:00:00.000Z");
});

test("exactly 31 days is allowed, so any calendar month works", async () => {
  const [status] = await sync("?startDate=2026-07-01&endDate=2026-07-31");
  assert.equal(status, 200);
});

test("32 days is rejected rather than quietly truncated", async () => {
  startCalls.length = 0;
  const [status, body] = await sync("?startDate=2026-07-01&endDate=2026-08-01");
  assert.equal(status, 400);
  assert.equal(body.error, "Date range cannot exceed 31 days");
  assert.equal(startCalls.length, 0, "nothing must have been started");
});

test("one date without the other is rejected", async () => {
  assert.deepEqual(await sync("?startDate=2026-07-01"),
    [400, { error: "startDate and endDate must be provided together" }]);
  assert.deepEqual(await sync("?endDate=2026-07-31"),
    [400, { error: "startDate and endDate must be provided together" }]);
});

test("a malformed or impossible date is rejected", async () => {
  for (const qs of ["?startDate=07-01-2026&endDate=2026-07-31",
                    "?startDate=2026-02-30&endDate=2026-03-01",
                    "?startDate=2026-13-01&endDate=2026-13-02",
                    "?startDate=yesterday&endDate=today"]) {
    const [status, body] = await sync(qs);
    assert.equal(status, 400, qs);
    assert.equal(body.error, "Invalid date: expected YYYY-MM-DD", qs);
  }
});

test("a backwards range is rejected", async () => {
  const [status, body] = await sync("?startDate=2026-07-31&endDate=2026-07-01");
  assert.equal(status, 400);
  assert.equal(body.error, "endDate must be on or after startDate");
});

test("full=true with a range is rejected — full ignores the window entirely", async () => {
  const [status, body] = await sync("?full=true&startDate=2026-07-01&endDate=2026-07-31");
  assert.equal(status, 400);
  assert.equal(body.error, "full=true cannot be combined with a custom date range");
});

test("no range params leave the default sync exactly as it was", async () => {
  startCalls.length = 0;
  const [status] = await sync("");
  assert.equal(status, 200);
  assert.equal(startCalls[0].scheduleDateFrom, undefined);
  assert.equal(startCalls[0].scheduleDateTo, undefined);
  assert.equal(startCalls[0].range, "month");
});
