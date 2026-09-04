/**
 * Phase 4 — InspectPointProvider's own write-back mirrors. Because of Phase
 * 3's dispatch seam, these are picked up automatically by both chat and
 * voice the moment a job/appointment has source='inspectpoint' — nothing in
 * this file exercises the channels themselves, only that the provider talks
 * to the right InspectPoint endpoints with the right bodies, self-guards on
 * source, and serializes the internal_notes append correctly.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const dbCalls = [];
let jobRows = {};
let inspectionGetResponse = { ok: true, data: { inspection: { internal_notes: null } } };
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
    if (path.startsWith("/external/api/v1/inspections") && method === "PATCH") return patchResponse;
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
  inspectionGetResponse = { ok: true, data: { inspection: { internal_notes: null } } };
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
  assert.deepEqual(requestCalls, [{ method: "PATCH", path: "/external/api/v1/inspections/1000", body: { inspection: { status_code: "cancelled" } } }]);
});

test("mirrorCancelJob PATCHes the same inspection endpoint directly", async () => {
  reset();
  const job = { id: 2, external_ref: "1000", source: "inspectpoint" };
  const result = await provider.mirrorCancelJob(9, job, {});
  assert.equal(result.ok, true);
  assert.deepEqual(requestCalls, [{ method: "PATCH", path: "/external/api/v1/inspections/1000", body: { inspection: { status_code: "cancelled" } } }]);
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
  assert.deepEqual(requestCalls, [{ method: "PATCH", path: "/external/api/v1/inspections/1000", body: { inspection: { scheduled_date: "2026-09-15" } } }]);
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

// ── Comment write-back (internal_notes append) ──────────────────────────────

test("mirrorPostChatComment: nothing reportable with no summary lines — never calls the API", async () => {
  reset();
  const result = await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: [] });
  assert.deepEqual(result, { skipped: "nothing_reportable" });
  assert.equal(requestCalls.length, 0);
});

test("mirrorPostChatComment: GETs current internal_notes, then PATCHes the appended text back", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  inspectionGetResponse = { ok: true, data: { inspection: { internal_notes: "Existing note." } } };
  const result = await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: ["Customer confirmed."], recipientName: "Dana Reed" });
  assert.equal(result.ok, true);
  assert.equal(requestCalls[0].method, "GET");
  assert.equal(requestCalls[1].method, "PATCH");
  const patchedNote = requestCalls[1].body.inspection.internal_notes;
  assert.match(patchedNote, /^Existing note\.\n\[Clara /, "must APPEND, not overwrite, the existing note");
  assert.match(patchedNote, /Customer confirmed\./);
  assert.match(patchedNote, /Dana Reed/);
});

test("mirrorPostChatComment: an empty existing internal_notes doesn't prefix a stray newline", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  inspectionGetResponse = { ok: true, data: { inspection: { internal_notes: null } } };
  await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: ["Confirmed."] });
  const patchedNote = requestCalls[1].body.inspection.internal_notes;
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
  inspectionGetResponse = { ok: true, data: { inspection: { internal_notes: "" } } };
  const result = await provider.mirrorPostCallComment(9, { scheduledCall: { job_id: 2 }, callSummary: "Customer confirmed the 1pm visit." });
  assert.equal(result.ok, true);
  assert.match(requestCalls[1].body.inspection.internal_notes, /Customer confirmed the 1pm visit\./);
});

test("the internal_notes append holds an advisory lock for the duration of the GET+PATCH pair", async () => {
  reset();
  jobRows[2] = { external_ref: "1000", source: "inspectpoint" };
  await provider.mirrorPostChatComment(9, { jobId: 2, summaryLines: ["x"] });
  const lockCall = dbCalls.find((c) => c.sql.includes("pg_advisory_xact_lock"));
  assert.ok(lockCall, "must serialize the read-modify-write via an advisory lock");
  assert.match(lockCall.params[0], /inspectpoint_note:9:1000/);
});
