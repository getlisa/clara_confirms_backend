/**
 * runSync's targeted mode — the webhook drain's only way into the sync engine.
 *
 * Separate file because the real servicetrade-sync must be loaded here, while
 * servicetrade-webhooks.test.js stubs it out.
 *
 * The invariant that would be a quiet disaster: a targeted run must NOT advance
 * any cursor. It covered one or two specific jobs; moving last_jobs_updated_at
 * to now would tell the next incremental run that everything up to this moment
 * is handled, silently losing every other job that changed since the last real
 * sync.
 *
 * The empty-list case is defence in depth rather than a live bug: `targeted` is
 * decided by the PRESENCE of options.jobIds, so an empty array already produces
 * zero job stubs and never reaches the list fetch. What the early return buys is
 * that the every-minute drain does no database work at all on an empty resolve —
 * and it keeps the behaviour correct if anyone ever rewrites that flag as
 * `options.jobIds?.length`, which WOULD send an empty array down the month-wide
 * path. The test below asserts the observable part: zero queries.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

const stCalls = [];
let stImpl = async () => ({ ok: true, status: 200, data: {}, messages: {} });
stub("services/servicetrade", {
  request: async (companyId, method, path, opts) => {
    stCalls.push({ method, path });
    return stImpl(companyId, method, path, opts);
  },
});

const credentialReads = [];
stub("db/servicetrade-credentials", {
  getByCompanyId: async (companyId) => { credentialReads.push(companyId); return { username: "u", authCode: "PHPSESSID=x" }; },
});

const stateWrites = [];
const stateReads = [];
stub("db/servicetrade-sync", new Proxy({
  getSyncState: async (companyId) => { stateReads.push(companyId); return { last_jobs_updated_at: 1700000000, last_appointments_updated_at: 1700000000 }; },
  updateSyncState: async (companyId, fields) => { stateWrites.push({ companyId, fields }); },
}, {
  // Every upsert*Batch the sync calls — accept and record nothing, so the run
  // proceeds without a database.
  get: (target, prop) => prop in target ? target[prop] : async () => {},
}));

const stEngine = require("../src/services/servicetrade-sync");

function reset() {
  stCalls.length = 0;
  stateWrites.length = 0;
  stateReads.length = 0;
  credentialReads.length = 0;
  stImpl = async () => ({ ok: true, status: 200, data: {}, messages: {} });
  logger.reset();
}

test("an empty jobIds array does no work — not even a database read", async () => {
  reset();
  const out = await stEngine.runSync(8, { jobIds: [] });
  assert.equal(out.success, true);
  assert.equal(stCalls.length, 0);
  assert.equal(stateWrites.length, 0);
  assert.equal(credentialReads.length, 0,
    "this runs every minute per company; an empty resolve must cost nothing");
  assert.equal(stateReads.length, 0);
});

test("an all-garbage jobIds array also does nothing", async () => {
  reset();
  const out = await stEngine.runSync(8, { jobIds: [null, undefined, "abc", "", "-1", {}] });
  assert.equal(out.success, true);
  assert.equal(stCalls.length, 0);
  assert.equal(credentialReads.length, 0);
});

test("targeted mode skips the /job list call and fetches the named ids directly", async () => {
  reset();
  stImpl = async (_c, _m, path) => path.startsWith("/job/")
    ? { ok: true, status: 200, data: { id: path.split("/")[2], name: "J", status: "scheduled" }, messages: {} }
    : { ok: true, status: 200, data: { totalPages: 1, page: 1, appointments: [] }, messages: {} };

  await stEngine.runSync(8, { jobIds: ["111", "222"] });

  const listCalls = stCalls.filter((c) => c.path.startsWith("/job?"));
  assert.equal(listCalls.length, 0, "the whole point is that ServiceTrade already told us which job");
  const detailCalls = stCalls.filter((c) => /^\/job\/\d+$/.test(c.path)).map((c) => c.path);
  assert.deepEqual(detailCalls.sort(), ["/job/111", "/job/222"]);
});

test("a targeted run never advances a cursor", async () => {
  reset();
  stImpl = async (_c, _m, path) => path.startsWith("/job/")
    ? { ok: true, status: 200, data: { id: "111", status: "scheduled" }, messages: {} }
    : { ok: true, status: 200, data: { totalPages: 1, page: 1, appointments: [] }, messages: {} };

  const out = await stEngine.runSync(8, { jobIds: ["111"] });
  assert.equal(out.targeted, true);
  assert.equal(stateWrites.length, 0,
    "advancing last_jobs_updated_at here would make the next incremental run skip every other changed job");
});

test("a normal run still advances cursors — the guard must not disable the poll", async () => {
  reset();
  stImpl = async (_c, _m, path) => path.startsWith("/job?")
    ? { ok: true, status: 200, data: { totalPages: 1, page: 1, jobs: [] }, messages: {} }
    : { ok: true, status: 200, data: { totalPages: 1, page: 1 }, messages: {} };

  const out = await stEngine.runSync(8, {});
  assert.equal(out.targeted, undefined);
  assert.equal(stateWrites.length, 1, "the hourly poll's incremental cursor must keep moving");
  assert.ok(stateWrites[0].fields.last_sync_at);
});

test("a huge id survives the round trip exactly", async () => {
  reset();
  const big = "9007199254740993"; // 2^53 + 1 — the first integer Number cannot hold
  stImpl = async (_c, _m, path) => path.startsWith("/job/")
    ? { ok: true, status: 200, data: { id: big, status: "scheduled" }, messages: {} }
    : { ok: true, status: 200, data: { totalPages: 1, page: 1, appointments: [] }, messages: {} };

  await stEngine.runSync(8, { jobIds: [big] });
  assert.ok(stCalls.some((c) => c.path === `/job/${big}`),
    "a Number round trip would request /job/9007199254740992 — a different job");
});

// ── Appointments deleted in the CRM ─────────────────────────────────────────
//
// Every write in this engine is an upsert, so before this a deleted appointment
// stayed in the platform as `scheduled` forever — counted by the job-status
// derivation and still eligible to be confirmed and called. ServiceTrade's
// `deleted` webhook covers the same ground but only while messages are actually
// delivered (3 attempts, then discarded), so the set-diff is the real detector.

const reconcileCalls = [];
const syncDbStub = require("../src/db/servicetrade-sync");
syncDbStub.reconcileAppointmentsForJob = async (companyId, jobRef, keepIds) => {
  reconcileCalls.push({ companyId, jobRef, keepIds });
  return { removed: [], cancelled: 0 };
};

function appointmentsFor(byJob) {
  return async (_c, _m, path) => {
    if (path.startsWith("/job/")) {
      return { ok: true, status: 200, data: { id: path.split("/")[2], status: "scheduled" }, messages: {} };
    }
    const jobId = new URLSearchParams(path.split("?")[1] || "").get("jobId");
    const ids = byJob[jobId];
    if (ids === "FAIL") return { ok: false, status: 500, data: null, messages: {} };
    return {
      ok: true, status: 200,
      data: { totalPages: 1, page: 1, appointments: (ids || []).map((id) => ({ id, status: "scheduled" })) },
      messages: {},
    };
  };
}

test("the surviving appointment set is handed to the reconcile, per job", async () => {
  reset(); reconcileCalls.length = 0;
  stImpl = appointmentsFor({ "111": ["9001", "9002"], "222": ["9003"] });

  await stEngine.runSync(8, { jobIds: ["111", "222"] });

  const byJob = Object.fromEntries(reconcileCalls.map((c) => [c.jobRef, c.keepIds]));
  assert.deepEqual(byJob["111"], ["9001", "9002"]);
  assert.deepEqual(byJob["222"], ["9003"]);
});

test("a job whose every appointment vanished still reconciles, with an empty set", async () => {
  reset(); reconcileCalls.length = 0;
  stImpl = appointmentsFor({ "111": [] });

  await stEngine.runSync(8, { jobIds: ["111"] });

  assert.equal(reconcileCalls.length, 1,
    "skipping on an empty response is exactly the case that leaves a deleted visit live");
  assert.deepEqual(reconcileCalls[0].keepIds, []);
});

test("a FAILED appointment fetch reconciles nothing — a truncated read is not a deletion", async () => {
  reset(); reconcileCalls.length = 0;
  stImpl = appointmentsFor({ "111": "FAIL", "222": ["9003"] });

  await stEngine.runSync(8, { jobIds: ["111", "222"] });

  const jobs = reconcileCalls.map((c) => c.jobRef);
  assert.ok(!jobs.includes("111"), "acting on a partial fetch would cancel live appointments");
  assert.deepEqual(jobs, ["222"], "the healthy job is still reconciled — one failure must not stall the rest");
});

test("completeness is tracked per job, not globally", async () => {
  // A single failing job must not suppress reconciliation for every other job
  // in the batch; that would quietly disable deletion detection account-wide.
  reset(); reconcileCalls.length = 0;
  stImpl = appointmentsFor({ "111": "FAIL", "222": [], "333": ["9004"] });

  await stEngine.runSync(8, { jobIds: ["111", "222", "333"] });

  assert.deepEqual(reconcileCalls.map((c) => c.jobRef).sort(), ["222", "333"]);
});

test("an unreadable appointment id aborts delete detection for that job", async () => {
  // Dropping the bad id from the keep-set instead would delete that very
  // appointment — "could not read the id" is not "it was deleted".
  reset(); reconcileCalls.length = 0;
  stImpl = appointmentsFor({ "111": ["9001", "not-an-id"], "222": ["9003"] });

  await stEngine.runSync(8, { jobIds: ["111", "222"] });

  assert.deepEqual(reconcileCalls.map((c) => c.jobRef), ["222"]);
  assert.equal(logger.records.warn.filter((w) => /unreadable appointment id/.test(w[0])).length, 1,
    "and it must be visible, not silently skipped");
});
