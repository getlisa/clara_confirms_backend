/**
 * Deactivated ServiceTrade contacts must reach the platform.
 *
 * Found on a real account: 254 contacts were deactivated and unlinked from
 * every company/location in ServiceTrade, and the platform kept all of them —
 * "public", still linked, still confirmation recipients. Every contact source
 * the sync had was blind to them: /contact?companyId= only returns active
 * contacts, and once a job's primary contact is repointed no job embeds the
 * old one either. The sync now reads /contact?status=inactive (undocumented,
 * verified live — `status=*` returns nothing on that endpoint).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

const stCalls = [];
let stImpl;
stub("services/servicetrade", {
  request: async (companyId, method, path, opts) => {
    stCalls.push({ method, path });
    return stImpl(companyId, method, path, opts);
  },
});
stub("db/servicetrade-credentials", {
  getByCompanyId: async () => ({ username: "u", authCode: "PHPSESSID=x" }),
});

const CURSOR = 1700000000;
const known = new Set();
const contactUpserts = [];
const stateWrites = [];
stub("db/servicetrade-sync", new Proxy({
  getSyncState: async () => ({ last_jobs_updated_at: CURSOR, last_appointments_updated_at: CURSOR }),
  updateSyncState: async (_c, fields) => { stateWrites.push(fields); },
  filterKnownContactIds: async (_c, ids) => new Set(ids.map(String).filter((id) => known.has(id))),
  upsertContactsBatch: async (_c, rows) => { contactUpserts.push(...rows); },
}, {
  get: (target, prop) => prop in target ? target[prop] : async () => {},
}));

const stEngine = require("../src/services/servicetrade-sync");

const inactiveContact = (id, extra = {}) => ({
  id, firstName: "Old", lastName: "Contact", email: `old${id}@x.test`, phone: "555",
  status: "inactive", locations: [], companies: [], ...extra,
});

let inactivePage;
function reset() {
  stCalls.length = 0;
  contactUpserts.length = 0;
  stateWrites.length = 0;
  known.clear();
  inactivePage = { ok: true, status: 200, data: { totalPages: 1, page: 1, contacts: [] }, messages: {} };
  stImpl = async (_c, _m, path) => {
    if (path.startsWith("/contact?") && path.includes("status=inactive")) return inactivePage;
    if (path.startsWith("/job?")) return { ok: true, status: 200, data: { totalPages: 1, page: 1, jobs: [] }, messages: {} };
    return { ok: true, status: 200, data: { totalPages: 1, page: 1 }, messages: {} };
  };
  logger.reset();
}

const inactiveCall = () => {
  const c = stCalls.find((x) => x.path.startsWith("/contact?") && x.path.includes("status=inactive"));
  return c && new URLSearchParams(c.path.split("?")[1]);
};

test("an incremental run reads contacts deactivated since the jobs cursor", async () => {
  reset();
  await stEngine.runSync(8, {});
  const qs = inactiveCall();
  assert.ok(qs, "the run must ask ServiceTrade for inactive contacts");
  assert.equal(qs.get("status"), "inactive");
  assert.equal(qs.get("updatedAfter"), String(CURSOR - 5 * 60), "borrows the jobs cursor with its usual overlap");
});

test("a full run re-reads every inactive contact", async () => {
  reset();
  await stEngine.runSync(8, { full: true });
  const qs = inactiveCall();
  assert.ok(qs);
  assert.equal(qs.get("updatedAfter"), null);
});

test("a targeted (webhook) run looks back one day", async () => {
  reset();
  const before = Math.floor(Date.now() / 1000);
  await stEngine.runSync(8, { jobIds: ["111"] });
  const qs = inactiveCall();
  assert.ok(qs, "a contact webhook drains as a targeted run — it must see the deactivation too");
  const after = Number(qs.get("updatedAfter"));
  assert.ok(after >= before - 86400 - 1 && after <= before - 86400 + 5);
});

test("only contacts the platform already holds are written, as inactive with their real (empty) links", async () => {
  reset();
  known.add("101");
  inactivePage.data.contacts = [inactiveContact(101), inactiveContact(202)];
  await stEngine.runSync(8, {});
  assert.deepEqual(contactUpserts.map((r) => r.servicetrade_id), [101],
    "an inactive contact we never imported has nothing on the platform to update");
  const [row] = contactUpserts;
  assert.equal(row.status, "inactive");
  assert.deepEqual(row.payload.locations, []);
  assert.deepEqual(row.payload.companies, []);
});

test("a failed inactive-contact fetch holds the jobs cursor back so the deactivation isn't skipped", async () => {
  reset();
  inactivePage = { ok: false, status: 400, data: null, messages: {} }; // 4xx: not retried
  await stEngine.runSync(8, {});
  assert.equal(stateWrites.length, 1);
  assert.equal(stateWrites[0].last_jobs_updated_at, undefined);
});

test("a clean run still advances the jobs cursor", async () => {
  reset();
  await stEngine.runSync(8, {});
  assert.equal(stateWrites.length, 1);
  assert.notEqual(stateWrites[0].last_jobs_updated_at, undefined);
});
