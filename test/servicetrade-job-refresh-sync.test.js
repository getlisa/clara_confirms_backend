/**
 * The ServiceTrade half of the per-job Refresh: runSync's targeted mode with
 * `withRelated` reads what /job/{id} and /appointment?jobId= don't embed — the
 * job's service requests and every deficiency at its location — and reports
 * job ids ServiceTrade 404s on, so the button can say "removed in ServiceTrade".
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

const stCalls = [];
let stImpl;
stub("services/servicetrade", {
  request: async (companyId, method, path, opts) => { stCalls.push(path); return stImpl(path); },
});
stub("db/servicetrade-credentials", { getByCompanyId: async () => ({ username: "u", authCode: "PHPSESSID=x" }) });

const writes = {};
stub("db/servicetrade-sync", new Proxy({
  getSyncState: async () => ({}),
  reconcileAppointmentsForJob: async () => ({ removed: 0 }),
  filterKnownRefs: async () => ({ contactIds: new Set(), customerIds: new Set(), locationIds: new Set() }),
}, {
  get: (target, prop) => prop in target ? target[prop] : async (_c, rows) => { (writes[prop] ||= []).push(...(rows || [])); },
}));

const stEngine = require("../src/services/servicetrade-sync");
const normalize = require("../src/services/crm/servicetrade/normalize");

const ok = (data) => ({ ok: true, status: 200, data, messages: {} });
function reset(over = {}) {
  stCalls.length = 0;
  for (const k of Object.keys(writes)) delete writes[k];
  stImpl = async (path) => {
    if (over[path.split("?")[0]] ) return over[path.split("?")[0]](path);
    if (path === "/job/111") return ok({ id: 111, status: "completed", location: { id: 900, name: "HQ" }, customer: { id: 5, name: "Acme" } });
    if (path.startsWith("/servicerequest?")) return ok({ totalPages: 1, servicerequests: [
      { id: 1, job: { id: 111 }, serviceLine: { id: 77, name: "Sprinkler" }, deficiency: { id: 300, title: "Embedded" }, contract: { id: 8, name: "Annual" } },
    ] });
    if (path.startsWith("/deficiency?")) return ok({ totalPages: 1, deficiencies: [
      { id: 300, title: "Deficient - Street Side", status: "verified", location: { id: 900 } },
      { id: 301, title: "Inoperable - Riser", status: "fixed", location: { id: 900 } },
    ] });
    return ok({ totalPages: 1, page: 1, appointments: [], contacts: [], comments: [] });
  };
}

test("withRelated fetches the job's service requests and its location's deficiencies", async () => {
  reset();
  const out = await stEngine.runSync(16, { jobIds: ["111"], withRelated: true });
  assert.equal(out.success, true);
  assert.ok(stCalls.some((p) => p.startsWith("/servicerequest?") && p.includes("jobId=111")));
  assert.ok(stCalls.some((p) => p.startsWith("/deficiency?") && p.includes("locationId=900")));
  assert.deepEqual(out.related.deficienciesByLocation, { 900: ["300", "301"] },
    "the complete set per location, so the caller can remove what ServiceTrade no longer has");
  // The full /deficiency record is written after the service-request embed, so it wins.
  const def300 = writes.upsertDeficienciesBatch.filter((r) => r.servicetrade_id === 300);
  assert.equal(def300[def300.length - 1].name, "Deficient - Street Side");
  assert.ok(writes.upsertContractsBatch.some((r) => r.servicetrade_id === 8), "embedded contracts are written too");
  assert.ok(writes.upsertServiceRequestsBatch.some((r) => r.servicetrade_id === 1));
});

test("a partial deficiency fetch is left out of deficienciesByLocation — nothing is removed on partial data", async () => {
  reset({ "/deficiency": async () => ({ ok: false, status: 400, data: null, messages: {} }) });
  const out = await stEngine.runSync(16, { jobIds: ["111"], withRelated: true });
  assert.deepEqual(out.related.deficienciesByLocation, {});
  assert.equal(out.related.complete, false);
});

test("without withRelated (webhook drains, regular syncs) none of these calls are made", async () => {
  reset();
  await stEngine.runSync(16, { jobIds: ["111"] });
  assert.ok(!stCalls.some((p) => p.startsWith("/servicerequest") || p.startsWith("/deficiency")));
});

test("a job ServiceTrade 404s on is reported in missingJobIds", async () => {
  reset({ "/job/111": async () => ({ ok: false, status: 404, data: null, messages: {} }) });
  const out = await stEngine.runSync(16, { jobIds: ["111"], withRelated: true });
  assert.deepEqual(out.missingJobIds, ["111"]);
});

// ── deficiency normalize ────────────────────────────────────────────────────

test("a ServiceTrade deficiency normalizes with status, resolved flag, location, service line and dates", () => {
  const n = normalize.normalizeDeficiency(
    { servicetrade_id: 300, name: null, ref_number: "D-1", payload: { title: "Deficient - Street Side", status: "verified", severity: "deficient", reportedOn: 1791989863 } },
    { companyId: 16, locationId: 4, serviceLineId: 12 }
  );
  assert.equal(n.name, "Deficient - Street Side", "title, since /deficiency has no name");
  assert.equal(n.status, "verified");
  assert.equal(n.isResolved, false);
  assert.equal(n.locationId, 4);
  assert.equal(n.serviceLineId, 12);
  assert.equal(n.openedAt, new Date(1791989863 * 1000).toISOString());
  assert.equal(n.additionalInformation.severity, "deficient");
});

test("fixed / invalid status, or a fixed / rejected / invalid resolution, counts as resolved", () => {
  const isResolved = (payload) => normalize.normalizeDeficiency({ servicetrade_id: 1, payload }, { companyId: 16 }).isResolved;
  assert.equal(isResolved({ status: "fixed" }), true);
  assert.equal(isResolved({ status: "invalid" }), true);
  assert.equal(isResolved({ status: "verified", resolution: "rejected" }), true);
  assert.equal(isResolved({ status: "new", resolution: "out_for_quote" }), false);
  assert.equal(isResolved({}), false);
});
