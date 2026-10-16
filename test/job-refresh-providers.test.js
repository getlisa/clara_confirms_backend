/**
 * The InspectPoint and ZenTrades halves of the per-job Refresh button
 * (docs/crm-sync-strategy.md §4.3a): one record re-read with its whole graph,
 * removed visits reconciled, sync state never touched.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

// ── InspectPoint ────────────────────────────────────────────────────────────

const ipCalls = [];
let ipImpl;
stub("services/inspectpoint", {
  request: async (_c, method, path) => { ipCalls.push(path); return ipImpl.request(path); },
  fetchAllPages: async (_c, path, params) => { ipCalls.push(`${path}?${new URLSearchParams(params)}`); return ipImpl.pages(path, params); },
});
stub("db/inspectpoint-credentials", { getByCompanyId: async () => ({ subdomain: "x", authCode: "k" }) });
const ipWrites = {};
const ipReconciles = [];
const ipStateWrites = [];
stub("db/inspectpoint-sync", {
  upsertRawBatch: async (table, _cols, _c, rows) => { (ipWrites[table] ||= []).push(...rows); return rows.length; },
  reconcileVisitsForInspection: async (_c, id, keep) => { ipReconciles.push({ id, keep }); return { removed: [], cancelled: 0 }; },
  updateSyncState: async (...a) => { ipStateWrites.push(a); },
  getSyncState: async () => ({}),
});
const ipSync = require("../src/services/inspectpoint-sync");

const ok = (data) => ({ ok: true, status: 200, data });
function resetIp(over = {}) {
  ipCalls.length = 0; ipReconciles.length = 0; ipStateWrites.length = 0;
  for (const k of Object.keys(ipWrites)) delete ipWrites[k];
  ipImpl = {
    request: async (path) => {
      if (over.inspection && path.includes("/v2/inspections/")) return over.inspection;
      if (path.includes("/v2/inspections/472")) return ok({ inspection: { id: 472, status_code: "pending", scheduled_time_iso: "2026-11-02T14:00:00Z", building: { id: 30, account_id: 9 } } });
      if (path.includes("/v1/buildings/30")) return ok({ id: 30, account_id: 9, name: "HQ" });
      if (path.includes("/v1/accounts/9")) return ok({ id: 9, name: "Acme" });
      return { ok: false, status: 404, data: null };
    },
    pages: async (path, params) => {
      if (path.endsWith("/inspection_visits")) {
        return over.visits || { rows: [{ id: 801, inspection_id: 472 }, { id: 999, inspection_id: 555 }], complete: true };
      }
      if (path.endsWith("/contacts")) return { rows: [{ id: params.building_id ? 61 : 62, account_id: 9 }], complete: true };
      if (path.endsWith("/deficiencies")) return { rows: [{ id: 300, building: { id: 30 } }], complete: true };
      if (path.endsWith("/technicians")) return { rows: [{ id: 5 }], complete: true };
      return { rows: [], complete: true };
    },
  };
}

test("InspectPoint: one inspection is re-read with its visits, building, account, contacts, deficiencies, technicians", async () => {
  resetIp();
  const r = await ipSync.refreshInspection(11, "472");
  assert.equal(r.success, true);
  assert.deepEqual(r.incomplete, []);
  assert.equal(ipWrites.inspectpoint_jobs[0].inspectpointId, 472);
  assert.equal(ipWrites.inspectpoint_locations[0].inspectpointId, 30);
  assert.equal(ipWrites.inspectpoint_customers[0].inspectpointId, 9);
  assert.deepEqual(ipWrites.inspectpoint_contacts.map((c) => c.inspectpointId).sort(), [61, 62], "building AND account contacts");
  assert.equal(ipWrites.inspectpoint_deficiencies[0].inspectpointId, 300);
  assert.equal(ipWrites.inspectpoint_technicians[0].inspectpointId, 5);
  assert.deepEqual(ipWrites.inspectpoint_appointments.map((v) => v.inspectpointId), [801],
    "a visit of another inspection (filter ignored server-side) is never attached here");
  assert.deepEqual(ipReconciles, [{ id: "472", keep: ["801"] }], "removed visits are reconciled");
  assert.equal(ipStateWrites.length, 0, "a one-inspection refresh never touches sync state");
});

test("InspectPoint: an incomplete visit fetch is never reconciled (nothing cancelled on partial data)", async () => {
  resetIp({ visits: { rows: [], complete: false } });
  const r = await ipSync.refreshInspection(11, "472");
  assert.equal(ipReconciles.length, 0);
  assert.ok(r.incomplete.includes("appointments"));
});

test("InspectPoint: 404 → not_in_crm, 401 → reconnect_required", async () => {
  resetIp({ inspection: { ok: false, status: 404, data: null } });
  assert.equal((await ipSync.refreshInspection(11, "472")).code, "not_in_crm");
  resetIp({ inspection: { ok: false, status: 401, data: null } });
  assert.equal((await ipSync.refreshInspection(11, "472")).code, "reconnect_required");
});

// ── ZenTrades ───────────────────────────────────────────────────────────────

let ztImpl;
stub("services/zentrades", { request: async (_c, _m, path, opts) => ztImpl(path, opts) });
let ztCreds = { authStatus: "ok", metadata: { zentradesCompanyId: 3 } };
stub("db/zentrades-credentials", { getByCompanyId: async () => ztCreds });
const ztWrites = {};
const ztReconciles = [];
stub("db/zentrades-sync", {
  upsertRawBatch: async (table, _cols, _c, rows) => { (ztWrites[table] ||= []).push(...rows); return rows.length; },
  reconcileAssignmentsForTicket: async (_c, id, keep) => { ztReconciles.push({ id, keep }); return { removed: [], cancelled: 0 }; },
  updateSyncState: async () => { throw new Error("must not touch sync state"); },
});
stub("db/todos", {});
const ztSync = require("../src/services/zentrades-sync");
const ztNormalize = require("../src/services/crm/zentrades/normalize");

const ticket = (over = {}) => ({
  id: 1923982, companyId: 3, jobStatus: "Complete", updatedAt: "2026-10-16T10:00:00Z",
  assignments: [{ id: 701, technician: { id: 4 }, startTime: "2026-10-20T14:00:00Z" }],
  serviceAddress: { id: 20, additionalContacts: [{ id: 21, email: "a@x.test" }] },
  customer: { id: 10, email: "c@x.test" },
  ...over,
});
function resetZt(t = ticket()) {
  for (const k of Object.keys(ztWrites)) delete ztWrites[k];
  ztReconciles.length = 0;
  ztCreds = { authStatus: "ok", metadata: { zentradesCompanyId: 3 } };
  ztImpl = async () => ({ ok: true, status: 200, data: t });
}

test("ZenTrades: one ticket (even a Complete one) is re-read with assignments, technicians, customer, address and contacts", async () => {
  resetZt();
  const r = await ztSync.refreshTicket(12, "1923982");
  assert.equal(r.success, true);
  assert.equal(ztWrites.zentrades_tickets[0].job_status, "Complete");
  assert.equal(ztWrites.zentrades_appointments[0].zentradesId, 701);
  assert.equal(ztWrites.zentrades_technicians[0].zentradesId, 4);
  assert.equal(ztWrites.zentrades_customers[0].zentradesId, 10);
  assert.equal(ztWrites.zentrades_locations[0].zentradesId, 20);
  assert.equal(ztWrites.zentrades_contacts.length, 3, "service address + additional + customer");
  assert.deepEqual(ztReconciles, [{ id: "1923982", keep: ["701"] }]);
});

test("ZenTrades: an unverified status label is NOT written — it would normalize to open and invite calls about finished work", async () => {
  resetZt(ticket({ jobStatus: "On Hold" }));
  const r = await ztSync.refreshTicket(12, "1923982");
  assert.deepEqual(r.incomplete, ["job_status"]);
  assert.equal(ztWrites.zentrades_tickets, undefined);
});

test("ZenTrades: wrong ticket / wrong tenant / re-auth needed are refused", async () => {
  resetZt(ticket({ id: 5 }));
  assert.equal((await ztSync.refreshTicket(12, "1923982")).code, "crm_unavailable");
  resetZt(ticket({ companyId: 99 }));
  assert.equal((await ztSync.refreshTicket(12, "1923982")).code, "crm_unavailable");
  resetZt();
  ztCreds = { authStatus: "invalid_credentials", metadata: {} };
  assert.equal((await ztSync.refreshTicket(12, "1923982")).code, "reconnect_required");
});

test("ZenTrades normalize: Complete → job completed and its (still active) assignments completed", () => {
  assert.equal(ztNormalize.mapJobStatus({ job_status: "Complete", payload: {} }).status, "completed");
  assert.equal(ztNormalize.mapJobStatus({ job_status: "Complete", payload: {} }).warning, null);
  assert.equal(ztNormalize.mapAssignmentStatus({ payload: { isActive: true } }, { ticketComplete: true }), "completed");
  assert.equal(ztNormalize.mapAssignmentStatus({ payload: { isActive: true } }), "scheduled");
  assert.equal(ztNormalize.mapAssignmentStatus({ payload: { isDeleted: true } }, { ticketComplete: true }), "cancelled");
});
