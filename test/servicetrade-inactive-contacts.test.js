/**
 * Contacts that change in ServiceTrade without a job changing must reach the
 * platform — on Sync now / the hourly poll, and on the webhook refresh.
 *
 * Found on a real account: 254 contacts were deactivated and unlinked from
 * every company/location in ServiceTrade, and the platform kept all of them —
 * "public", still linked, still confirmation recipients. Every contact source
 * the sync had was blind to them: /contact?companyId= only returns active
 * contacts, and once a job's primary contact is repointed no job embeds the
 * old one either. The sync now reads /contact?status=inactive (undocumented,
 * verified live — `status=*` returns nothing on that endpoint) and the
 * contacts updated since the cursor, and a webhook contact event fetches the
 * contact by id.
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
const known = { contacts: new Set(), customers: new Set(), locations: new Set() };
const contactUpserts = [];
const stateWrites = [];
const pick = (set, ids) => new Set(ids.map(String).filter((id) => set.has(id)));
stub("db/servicetrade-sync", new Proxy({
  getSyncState: async () => ({ last_jobs_updated_at: CURSOR, last_appointments_updated_at: CURSOR }),
  updateSyncState: async (_c, fields) => { stateWrites.push(fields); },
  filterKnownRefs: async (_c, { contactIds = [], customerIds = [], locationIds = [] }) => ({
    contactIds: pick(known.contacts, contactIds),
    customerIds: pick(known.customers, customerIds),
    locationIds: pick(known.locations, locationIds),
  }),
  upsertContactsBatch: async (_c, rows) => { contactUpserts.push(...rows); },
}, {
  get: (target, prop) => prop in target ? target[prop] : async () => {},
}));

const stEngine = require("../src/services/servicetrade-sync");

const contact = (id, extra = {}) => ({
  id, firstName: "A", lastName: "Contact", email: `c${id}@x.test`, phone: "555",
  status: "public", locations: [], companies: [], ...extra,
});
const ok = (data) => ({ ok: true, status: 200, data: { totalPages: 1, page: 1, ...data }, messages: {} });

let inactivePage, activePage, byId;
function reset() {
  stCalls.length = 0;
  contactUpserts.length = 0;
  stateWrites.length = 0;
  for (const s of Object.values(known)) s.clear();
  inactivePage = ok({ contacts: [] });
  activePage = ok({ contacts: [] });
  byId = new Map();
  stImpl = async (_c, _m, path) => {
    if (path.startsWith("/contact?")) return path.includes("status=inactive") ? inactivePage : activePage;
    if (path.startsWith("/contact/")) {
      const c = byId.get(path.split("/")[2]);
      return c ? { ok: true, status: 200, data: c, messages: {} } : { ok: false, status: 404, data: null, messages: {} };
    }
    if (path.startsWith("/job?")) return ok({ jobs: [] });
    return ok({});
  };
  logger.reset();
}

const contactListCalls = () => stCalls
  .filter((x) => x.path.startsWith("/contact?"))
  .map((x) => new URLSearchParams(x.path.split("?")[1]));

// ── Sync now / hourly poll ──────────────────────────────────────────────────

test("an incremental run reads inactive AND updated contacts since the jobs cursor", async () => {
  reset();
  await stEngine.runSync(8, {});
  const calls = contactListCalls();
  assert.equal(calls.length, 2);
  const since = String(CURSOR - 5 * 60);
  assert.ok(calls.some((q) => q.get("status") === "inactive" && q.get("updatedAfter") === since));
  assert.ok(calls.some((q) => q.get("status") === null && q.get("updatedAfter") === since),
    "a contact edited at a customer whose jobs didn't change is otherwise invisible to Sync now");
});

test("a full run re-reads every inactive contact but never lists the whole account's active ones", async () => {
  reset();
  await stEngine.runSync(8, { full: true });
  const calls = contactListCalls();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].get("status"), "inactive");
  assert.equal(calls[0].get("updatedAfter"), null);
});

test("inactive contacts: only ones the platform holds are written, flagged as full records", async () => {
  reset();
  known.contacts.add("101");
  known.customers.add("900");
  inactivePage = ok({ contacts: [contact(101, { status: "inactive" }), contact(202, { status: "inactive", companies: [{ id: 900 }] })] });
  await stEngine.runSync(8, {});
  assert.deepEqual(contactUpserts.map((r) => r.servicetrade_id), [101],
    "an inactive contact we never imported has nothing on the platform to update — even at a known customer");
  const [row] = contactUpserts;
  assert.equal(row.status, "inactive");
  assert.deepEqual(row.payload.locations, []);
  assert.equal(row.payload._fullRecord, true, "its empty links are the truth, not an absence of data");
});

test("updated active contacts: written when held, or when they belong to a customer/location we hold", async () => {
  reset();
  known.contacts.add("1");
  known.customers.add("900");
  known.locations.add("700");
  activePage = ok({ contacts: [
    contact(1),                                         // held — e.g. its phone changed
    contact(2, { companies: [{ id: 900 }] }),           // new colleague at a known customer
    contact(3, { company: { id: 900 } }),               // singular `company` only (seen live)
    contact(4, { locations: [{ id: 700 }] }),           // new contact at a known location
    contact(5, { companies: [{ id: 111 }] }),           // someone else's customer
  ] });
  await stEngine.runSync(8, {});
  assert.deepEqual(contactUpserts.map((r) => r.servicetrade_id).sort(), [1, 2, 3, 4]);
});

test("a failed contact fetch holds the jobs cursor back so the change isn't skipped", async () => {
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

// ── Webhook refresh ─────────────────────────────────────────────────────────

test("a targeted run with only contactIds fetches each contact by id — no job, no list call", async () => {
  reset();
  known.contacts.add("101");
  byId.set("101", contact(101, { status: "inactive" }));
  const out = await stEngine.runSync(8, { jobIds: [], contactIds: ["101", "404"] });
  assert.equal(out.success, true);
  assert.equal(out.targeted, true);
  assert.deepEqual(stCalls.map((c) => c.path).sort(), ["/contact/101", "/contact/404"]);
  assert.deepEqual(contactUpserts.map((r) => r.servicetrade_id), [101]);
  assert.equal(contactUpserts[0].status, "inactive");
  assert.equal(stateWrites.length, 0, "a targeted run never advances a cursor");
});

test("a targeted job-only run makes no contact calls at all", async () => {
  reset();
  stImpl = async (_c, _m, path) => path.startsWith("/job/")
    ? { ok: true, status: 200, data: { id: "111", status: "scheduled" }, messages: {} }
    : ok({ appointments: [] });
  await stEngine.runSync(8, { jobIds: ["111"] });
  assert.equal(stCalls.filter((c) => c.path.startsWith("/contact")).length, 0,
    "the webhook drain runs every minute — job events must not pay for contact lists");
});

// ── Deficiencies in the regular sync ────────────────────────────────────────
// Nothing in the regular sync read ServiceTrade deficiencies, so every first
// job Refresh reported its location's deficiencies as "added" although nobody
// had changed anything in ServiceTrade.

const defCalls = () => stCalls.filter((c) => c.path.startsWith("/deficiency?")).map((c) => new URLSearchParams(c.path.split("?")[1]));

test("an incremental run reads deficiencies changed since the jobs cursor; a full run reads them all", async () => {
  reset();
  await stEngine.runSync(8, {});
  assert.equal(defCalls().length, 1);
  assert.equal(defCalls()[0].get("updatedAfter"), String(CURSOR - 5 * 60));
  reset();
  await stEngine.runSync(8, { full: true });
  assert.equal(defCalls()[0].get("updatedAfter"), null);
});

test("only deficiencies at locations the platform holds are written", async () => {
  reset();
  known.locations.add("900");
  const base = stImpl;
  stImpl = async (c, m, path) => path.startsWith("/deficiency?")
    ? ok({ deficiencies: [
        { id: 1, title: "Deficient - Street Side", status: "verified", location: { id: 900 } },
        { id: 2, title: "Elsewhere", status: "new", location: { id: 777 } },
        { id: 3, title: "No location" },
      ] })
    : base(c, m, path);
  const writes = [];
  const syncDbStub = require("../src/db/servicetrade-sync");
  const orig = syncDbStub.upsertDeficienciesBatch;
  syncDbStub.upsertDeficienciesBatch = async (_c, rows) => { writes.push(...rows); };
  try {
    await stEngine.runSync(8, {});
  } finally {
    syncDbStub.upsertDeficienciesBatch = orig;
  }
  assert.deepEqual(writes.map((r) => r.servicetrade_id), [1]);
  assert.equal(writes[0].name, "Deficient - Street Side");
});

test("a failed deficiency fetch holds the jobs cursor back", async () => {
  reset();
  const base = stImpl;
  stImpl = async (c, m, path) => path.startsWith("/deficiency?") ? { ok: false, status: 400, data: null, messages: {} } : base(c, m, path);
  await stEngine.runSync(8, {});
  assert.equal(stateWrites[0].last_jobs_updated_at, undefined);
});

test("a targeted (webhook / refresh) run never runs the account-wide deficiency pass", async () => {
  reset();
  await stEngine.runSync(8, { jobIds: [], contactIds: ["101"] });
  assert.equal(defCalls().length, 0);
});
