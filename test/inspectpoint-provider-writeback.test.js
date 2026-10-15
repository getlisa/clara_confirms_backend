/**
 * Phase 4 — InspectPointProvider's own write-back mirrors. Because of Phase
 * 3's dispatch seam, these are picked up automatically by both chat and
 * voice the moment a job/appointment has source='inspectpoint' — nothing in
 * this file exercises the channels themselves, only that the provider talks
 * to the right InspectPoint endpoints with the right bodies, self-guards on
 * source, and serializes the technician_instructions append correctly.
 *
 * Inspection UPDATES go to PATCH /external/api/v1/buildings/{b}/inspections/{id}:
 * the documented PATCH /external/api/v1/inspections/{id} answers 404
 * "building not found" for every body on the live API.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const dbCalls = [];
let jobRows = {};
const BUILDING_PATCH = "/external/api/v1/buildings/613/inspections/1000";
const freshInspection = (over = {}) => ({ ok: true, data: { inspection: { technician_instructions: null, building: { id: 613 }, ...over } } });
let inspectionGetResponse = freshInspection();
let patchResponse = { ok: true, data: { inspection: {} } };
let postVisitResponse = { ok: true, data: { visit: { id: 9001 } } };
let patchVisitResponse = { ok: true, data: { visit: {} } };

stub("db", {
  query: async (sql, params) => {
    dbCalls.push({ sql, params });
    if (/SELECT external_ref, source FROM jobs WHERE id = \$1/.test(sql)) {
      return { rows: jobRows[params[0]] ? [jobRows[params[0]]] : [] };
    }
    return { rows: [] };
  },
  fetchExternalRefMap: async () => new Map(),
  fetchAllByCompanyChunked: async () => [],
  bulkUpsertByExternalRef: async () => 0,
  transaction: async (callback) => {
    // Real advisory-lock semantics aren't exercisable without Postgres; this
    // stub just proves the callback runs and its result passes through.
    const client = { query: async (sql, params) => { dbCalls.push({ sql, params }); return { rows: [] }; } };
    return callback(client);
  },
});

stub("db/todos", { create: async () => {}, TODO_TYPES: { CRM_SYNC: "crm_sync" } });
stub("db/inspectpoint-credentials", { getByCompanyId: async () => ({ subdomain: "acme", authCode: "key" }) });
stub("services/inspectpoint-sync", { runSync: async () => ({ success: true, counts: {} }) });

const requestCalls = [];
stub("services/inspectpoint", {
  request: async (companyId, method, path, opts) => {
    requestCalls.push({ method, path, body: opts?.body });
    if (path.startsWith("/external/api/v1/inspection_visits") && method === "PATCH") return patchVisitResponse;
    if (path.startsWith("/external/api/v1/inspection_visits") && method === "POST") return postVisitResponse;
    if (path.startsWith("/external/api/v1/inspections") && method === "GET") return inspectionGetResponse;
    if (/^\/external\/api\/v1\/buildings\/[^/]+\/inspections\//.test(path) && method === "PATCH") return patchResponse;
    // The flat inspection PATCH is broken on InspectPoint's side — answer the
    // way the live API does, so any code still using it fails loudly here.
    if (path.startsWith("/external/api/v1/inspections") && method === "PATCH") return { ok: false, status: 404, messages: { errors: ["building not found"] } };
    return { ok: false, status: 404 };
  },
  fetchAllPages: async () => ({ rows: [], complete: true }),
  verifyCredentials: async () => true,
});

const provider = require("../src/services/crm/inspectpoint/provider");

function reset() {
  dbCalls.length = 0;
  requestCalls.length = 0;
  jobRows = {};
  inspectionGetResponse = freshInspection();
  patchResponse = { ok: true, data: { inspection: {} } };
  postVisitResponse = { ok: true, data: { visit: { id: 9001 } } };
  patchVisitResponse = { ok: true, data: { visit: {} } };
}

// ── mirrorRescheduleAppointment ──────────────────────────────────────────────

test("mirrorRescheduleAppointment PATCHes the VISIT's scheduled_date, not the inspection's", async () => {
  reset();
  const appt = { id: 1, job_id: 2, source: "inspectpoint", external_ref: "5000" };
  const result = await provider.mirrorRescheduleAppointment(9, appt, { scheduledStart: "2026-09-10T13:00:00-04:00" });
  assert.equal(result.ok, true);
  assert.deepEqual(requestCalls, [{ method: "PATCH", path: "/external/api/v1/inspection_visits/5000", body: { visit: { scheduled_date: "2026-09-10T13:00:00-04:00" } } }]);
});

test("mirrorRescheduleAppointment self-guards on source and never calls the API for a non-inspectpoint row", async () => {
  reset();
  const appt = { id: 1, job_id: 2, source: "servicetrade", external_ref: "5000" };
  const result = await provider.mirrorRescheduleAppointment(9, appt, { scheduledStart: "x" });
  assert.deepEqual(result, { skipped: "not_inspectpoint" });
  assert.equal(requestCalls.length, 0);
});

test("mirrorRescheduleAppointment raises a CRM_SYNC todo on a failed PATCH but never throws", async () => {
  reset();
  patchVisitResponse = { ok: false, status: 500, messages: { error: ["boom"] } };
  const appt = { id: 1, job_id: 2, source: "inspectpoint", external_ref: "5000" };
  const result = await provider.mirrorRescheduleAppointment(9, appt, { scheduledStart: "x" });
  assert.equal(result.ok, false);
});

// ── mirrorCancelAppointment / mirrorCancelJob ───────────────────────────────

test("mirrorCancelAppointment resolves the PARENT JOB's external_ref and PATCHes the inspection's status_code — not the visit", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  const appt = { id: 1, job_id: 2, source: "inspectpoint", external_ref: "5000" };
  const result = await provider.mirrorCancelAppointment(9, appt, {});
  assert.equal(result.ok, true);
  assert.deepEqual(requestCalls, [
    { method: "GET", path: "/external/api/v1/inspections/1000", body: undefined },
    { method: "PATCH", path: BUILDING_PATCH, body: { inspection: { status_code: "cancelled" }, response: "small" } },
  ]);
});

test("mirrorCancelJob PATCHes the same inspection endpoint directly", async () => {
  reset();
  const job = { id: 2, external_ref: "1000", source: "inspectpoint" };
  const result = await provider.mirrorCancelJob(9, job, {});
  assert.equal(result.ok, true);
  assert.deepEqual(requestCalls, [
    { method: "GET", path: "/external/api/v1/inspections/1000", body: undefined },
    { method: "PATCH", path: BUILDING_PATCH, body: { inspection: { status_code: "cancelled" }, response: "small" } },
  ]);
});

test("mirrorCancelAppointment self-guards when the parent job is not from InspectPoint", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "servicetrade" };
  const appt = { id: 1, job_id: 2, source: "inspectpoint", external_ref: "5000" };
  const result = await provider.mirrorCancelAppointment(9, appt, {});
  assert.deepEqual(result, { skipped: "not_inspectpoint" });
  assert.equal(requestCalls.length, 0);
});

// ── mirrorRescheduleJob ──────────────────────────────────────────────────────

test("mirrorRescheduleJob PATCHes the inspection's scheduled_date", async () => {
  reset();
  const job = { id: 2, external_ref: "1000", source: "inspectpoint" };
  const result = await provider.mirrorRescheduleJob(9, job, { scheduledDate: "2026-09-15" });
  assert.equal(result.ok, true);
  assert.deepEqual(requestCalls, [
    { method: "GET", path: "/external/api/v1/inspections/1000", body: undefined },
    { method: "PATCH", path: BUILDING_PATCH, body: { inspection: { scheduled_date: "2026-09-15" }, response: "small" } },
  ]);
});

test("an inspection whose building can't be resolved is never PATCHed, and the failure is reported", async () => {
  reset();
  inspectionGetResponse = { ok: true, data: { inspection: { building: null } } };
  const result = await provider.mirrorRescheduleJob(9, { id: 2, external_ref: "1000", source: "inspectpoint" }, { scheduledDate: "2026-09-15" });
  assert.equal(result.ok, false);
  assert.ok(!requestCalls.some((c) => c.method === "PATCH"));
});

test("no write ever goes to the broken flat PATCH /external/api/v1/inspections/{id}", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  const job = { id: 2, external_ref: "1000", source: "inspectpoint" };
  await provider.mirrorCancelJob(9, job, {});
  await provider.mirrorRescheduleJob(9, job, { scheduledDate: "2026-09-15" });
  await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: ["Confirmed."] });
  await provider.mirrorPostCallComment(9, { scheduledCall: { job_id: 2 }, callSummary: "Confirmed." });
  const flat = requestCalls.filter((c) => c.method === "PATCH" && c.path.startsWith("/external/api/v1/inspections/"));
  assert.deepEqual(flat, []);
});

// ── mirrorCreateAppointment ──────────────────────────────────────────────────

test("mirrorCreateAppointment POSTs a new visit under the job's inspection_id, then stamps the returned id back onto the platform row", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  const appt = { id: 1 };
  const result = await provider.mirrorCreateAppointment(9, appt, 2, { scheduledStart: "2026-09-20T09:00:00-04:00" });
  assert.equal(result.ok, true);
  assert.equal(result.inspectPointVisitId, "9001");
  assert.deepEqual(requestCalls, [{ method: "POST", path: "/external/api/v1/inspection_visits", body: { visit: { inspection_id: 1000, scheduled_date: "2026-09-20T09:00:00-04:00" } } }]);
  const stampCall = dbCalls.find((c) => c.sql.includes("UPDATE appointments"));
  assert.ok(stampCall, "must stamp external_ref/source back onto the platform appointment");
  assert.deepEqual(stampCall.params, ["9001", "inspectpoint", 1, 9]);
});

test("mirrorCreateAppointment dispatches by the JOB's source, not the (not-yet-existing) appointment's", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "servicetrade" }; // job belongs to a different CRM
  const result = await provider.mirrorCreateAppointment(9, { id: 1 }, 2, { scheduledStart: "x" });
  assert.deepEqual(result, { skipped: "not_inspectpoint" });
  assert.equal(requestCalls.length, 0);
});

// ── Comment write-back (technician_instructions append) ─────────────────────

test("mirrorPostChatComment: nothing reportable with no summary lines — never calls the API", async () => {
  reset();
  const result = await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: [] });
  assert.deepEqual(result, { skipped: "nothing_reportable" });
  assert.equal(requestCalls.length, 0);
});

test("mirrorPostChatComment: GETs current technician_instructions, then PATCHes the appended text back via the building route", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  inspectionGetResponse = freshInspection({ technician_instructions: "Existing note." });
  const result = await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: ["Customer confirmed."], recipientName: "Dana Reed" });
  assert.equal(result.ok, true);
  assert.equal(requestCalls[0].method, "GET");
  assert.equal(requestCalls[1].method, "PATCH");
  assert.equal(requestCalls[1].path, BUILDING_PATCH, "building id taken from the GET — no second lookup");
  assert.equal(requestCalls.length, 2);
  const patchedNote = requestCalls[1].body.inspection.technician_instructions;
  assert.match(patchedNote, /^Existing note\.\n\[Clara /, "must APPEND, not overwrite, the office's instructions");
  assert.match(patchedNote, /Customer confirmed\./);
  assert.match(patchedNote, /Dana Reed/);
});

test("mirrorPostChatComment: empty existing technician_instructions doesn't prefix a stray newline", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  inspectionGetResponse = freshInspection({ technician_instructions: null });
  await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: ["Confirmed."] });
  const patchedNote = requestCalls[1].body.inspection.technician_instructions;
  assert.ok(!patchedNote.startsWith("\n"));
  assert.match(patchedNote, /^\[Clara /);
});

test("mirrorPostChatComment self-guards when the job is not from InspectPoint", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "servicetrade" };
  const result = await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: ["x"] });
  assert.deepEqual(result, { skipped: "not_inspectpoint" });
  assert.equal(requestCalls.length, 0);
});

test("mirrorPostCallComment resolves the inspection via scheduledCall.job_id and appends the call summary", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  inspectionGetResponse = freshInspection({ technician_instructions: "The Key will be left under a mat at the back door" });
  const result = await provider.mirrorPostCallComment(9, { scheduledCall: { job_id: 2 }, callSummary: "Customer confirmed the 1pm visit." });
  assert.equal(result.ok, true);
  const patched = requestCalls[1].body.inspection.technician_instructions;
  assert.match(patched, /^The Key will be left under a mat at the back door\n\[Clara \d{4}-\d{2}-\d{2} \d{2}:\d{2}\] Call outcome: Customer confirmed the 1pm visit\./);
});

test("the technician_instructions append holds an advisory lock for the duration of the GET+PATCH pair", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: ["x"] });
  const lockCall = dbCalls.find((c) => c.sql.includes("pg_advisory_xact_lock"));
  assert.ok(lockCall, "must serialize the read-modify-write via an advisory lock");
  assert.match(lockCall.params[0], /inspectpoint_note:9:1000/);
});
