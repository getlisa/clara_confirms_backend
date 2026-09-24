/**
 * ZenTradesProvider's write-back mirrors — the seven CRM write-back methods
 * built against api_doc/ztticket_update.md (PUT /api/ticket/update) and
 * api_doc/zentrades.md §4 (the notes endpoint). Fake db + a spy on
 * services/zentrades.request throughout, following the exact convention
 * test/inspectpoint-provider-writeback.test.js established.
 *
 * Heaviest coverage on the two things that are genuinely easy to get wrong
 * against this specific contract:
 *  - existingData must come from OUR OWN raw snapshot, never the platform
 *    row the mirror's own call site just updated to the NEW value — get
 *    this backwards and ZenTrades sends the customer the wrong SMS template.
 *  - a 200 OK does not mean the write landed (no request-schema validation
 *    on this route) — verify() must actually check the echo.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

// ── Fake db: routes a handful of known query shapes, everything else empty ──

let jobRows = {};              // platformJobId -> {external_ref, source}
let jobIdByExternalRef = {};   // external_ref -> platformJobId
let appointmentsByJob = {};    // platformJobId -> [{external_ref, scheduled_start, scheduled_end, status}]
let techniciansById = {};      // platform technician_id -> external_ref
let rawAppointments = {};      // assignmentId -> {scheduled_start, scheduled_end, zentrades_technician_id, assignment_status_id}
let locationsPrimaryContact = {};
const dbCalls = [];

stub("db", {
  query: async (sql, params) => {
    dbCalls.push({ sql, params });
    if (/SELECT external_ref, source FROM jobs WHERE id = \$1/.test(sql)) {
      return { rows: jobRows[params[0]] ? [jobRows[params[0]]] : [] };
    }
    if (/SELECT id FROM jobs WHERE company_id = \$1 AND source = \$2 AND external_ref = \$3/.test(sql)) {
      const id = jobIdByExternalRef[params[2]];
      return { rows: id ? [{ id }] : [] };
    }
    // Order matters: check the MOST SPECIFIC column list / clause set first,
    // since all three real queries share the same "FROM appointments WHERE
    // job_id = $1 AND company_id = $2 AND source = $3" prefix and differ only
    // in the SELECT list and trailing clauses.
    if (/SELECT external_ref, scheduled_start, scheduled_end FROM appointments/.test(sql) && /status <> 'cancelled'/.test(sql)) {
      // mirrorRescheduleJob's live-assignments query.
      const rows = (appointmentsByJob[params[0]] || []).filter((a) => a.status !== "cancelled");
      return { rows: rows.map((a) => ({ external_ref: a.external_ref, scheduled_start: a.scheduled_start, scheduled_end: a.scheduled_end })) };
    }
    if (/^SELECT external_ref FROM appointments/.test(sql) && /external_ref IS NOT NULL/.test(sql)) {
      // mirrorCancelJob's delete-list query.
      const rows = appointmentsByJob[params[0]] || [];
      return { rows: rows.map((a) => ({ external_ref: a.external_ref })) };
    }
    if (/^SELECT external_ref FROM appointments WHERE job_id = \$1 AND company_id = \$2 AND source = \$3\s*$/.test(sql)) {
      // mirrorCreateAppointment's "which visits do we already know about" query.
      const rows = appointmentsByJob[params[0]] || [];
      return { rows: rows.map((a) => ({ external_ref: a.external_ref })) };
    }
    if (/SELECT external_ref FROM technicians WHERE id = \$1/.test(sql)) {
      const ref = techniciansById[params[0]];
      return { rows: ref != null ? [{ external_ref: ref }] : [] };
    }
    if (/SELECT scheduled_start, scheduled_end, zentrades_technician_id, assignment_status_id\s+FROM zentrades_appointments/.test(sql)) {
      const row = rawAppointments[params[1]];
      return { rows: row ? [row] : [] };
    }
    if (/UPDATE appointments SET external_ref/.test(sql)) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [] };
  },
  fetchExternalRefMap: async () => new Map(),
  fetchAllByCompanyChunked: async () => [],
  bulkUpsertByExternalRef: async () => 0,
});

const todoCalls = [];
stub("db/todos", {
  create: async (args) => { todoCalls.push(args); return { id: todoCalls.length }; },
  TODO_TYPES: { CRM_SYNC: "CRM_SYNC" },
});

stub("db/zentrades-credentials", {
  getByCompanyId: async () => ({ authStatus: "ok", metadata: { timezoneRegionName: "America/Toronto" } }),
});
stub("services/zentrades-sync", { runSync: async () => ({ success: true, counts: {} }) });

const requestCalls = [];
let nextResponse = { ok: true, status: 200, data: {} };
stub("services/zentrades", {
  request: async (companyId, method, path, opts) => {
    requestCalls.push({ companyId, method, path, body: opts?.body, opts });
    return typeof nextResponse === "function" ? nextResponse({ method, path, body: opts?.body }) : nextResponse;
  },
  fetchAllPages: async () => ({ rows: [], complete: true, count: 0 }),
  verifyCredentials: async () => ({ ok: true }),
});

const provider = require("../src/services/crm/zentrades/provider");

function reset() {
  jobRows = {};
  jobIdByExternalRef = {};
  appointmentsByJob = {};
  techniciansById = {};
  rawAppointments = {};
  locationsPrimaryContact = {};
  dbCalls.length = 0;
  todoCalls.length = 0;
  requestCalls.length = 0;
  nextResponse = { ok: true, status: 200, data: {} };
}

// ── mirrorRescheduleAppointment ──────────────────────────────────────────────

test("mirrorRescheduleAppointment sends assignments.update with plain UTC wall-clock (T/Z stripped, NOT converted to tenant-local)", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  rawAppointments[99812] = { scheduled_start: new Date("2026-09-12T18:00:00.000Z"), scheduled_end: new Date("2026-09-12T21:30:00.000Z"), zentrades_technician_id: 488, assignment_status_id: 2 };
  // The REAL API echoes full ISO ("...Z"), not the wall-clock shape we send —
  // verified live (2026-09-09, ticket 1675140/assignment 2395356). Using that
  // real shape here (not a wall-clock echo) is what pins the fix below.
  nextResponse = { ok: true, status: 200, data: { assignments: [{ id: 99812, startTime: "2026-09-14T13:00:00.000Z" }] } };

  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  // Verified live against a real ZenTrades ticket (2026-09-09): GET /api/ticket
  // returns startTime as full UTC ISO ("...Z"). The wire wall-clock format is
  // that same UTC instant with T/Z stripped — a tenant-local conversion here
  // makes existingData disagree with ZenTrades by exactly the tenant's UTC
  // offset, which the overwrite guard reads as a conflict (E104).
  const result = await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z", scheduledEnd: "2026-09-14T16:30:00.000Z" });

  assert.equal(result.ok, true);
  const call = requestCalls[0];
  assert.equal(call.method, "PUT");
  assert.equal(call.path, "/api/ticket/update");
  assert.equal(call.body.id, 18423);
  const update = call.body.assignments.update[0];
  assert.equal(update.id, 99812);
  assert.equal(update.startTime, "2026-09-14 13:00:00");
  assert.equal(update.endTime, "2026-09-14 16:30:00");
});

test("verify() tolerates the echo's real ISO shape against the wall-clock we sent — a genuinely successful write must not report echo_verification_failed (regression: live call_1dd2f42df7ae51d405e92fea1a1, 2026-09-09)", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  // The write landed (ZenTrades' own GET confirmed the new time), but the PUT
  // response echoes ISO ("...T14:00:00.000Z") while we sent wall-clock
  // ("2026-09-15 14:00:00") — a naive string/slice compare of these two shapes
  // never matches even though they're the same instant.
  nextResponse = { ok: true, status: 200, data: { assignments: [{ id: 99812, startTime: "2026-09-15T14:00:00.000Z", endTime: "2026-09-15T16:00:00.000Z" }] } };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  const result = await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-15T14:00:00.000Z", scheduledEnd: "2026-09-15T16:00:00.000Z" });
  assert.equal(result.ok, true, "a real successful write must not be reported as echo_verification_failed");
});

test("mirrorRescheduleAppointment's existingData comes from the RAW snapshot (the OLD ZenTrades-side values), never the platform row's new value", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  // The raw snapshot still holds the OLD time — this is what existingData must reflect.
  rawAppointments[99812] = { scheduled_start: new Date("2026-09-12T18:00:00.000Z"), scheduled_end: new Date("2026-09-12T21:30:00.000Z"), zentrades_technician_id: 488, assignment_status_id: 2 };
  nextResponse = { ok: true, status: 200, data: { assignments: [{ id: 99812, startTime: "2026-09-14 13:00:00" }] } };

  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z" });

  const existingData = requestCalls[0].body.assignments.update[0].existingData;
  assert.equal(existingData.startTime, "2026-09-12 18:00:00", "must be the OLD raw-table time (plain UTC, T/Z stripped), not the new one being sent");
  assert.equal(existingData.technicianId, 488);
  assert.equal(existingData.assignmentStatusId, 2);
});

test("mirrorRescheduleAppointment omits existingData (and logs) when no raw snapshot exists, rather than fabricating one", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  // No rawAppointments entry for 99812.
  nextResponse = { ok: true, status: 200, data: { assignments: [{ id: 99812, startTime: "2026-09-14 13:00:00" }] } };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z" });
  assert.equal("existingData" in requestCalls[0].body.assignments.update[0], false);
});

test("mirrorRescheduleAppointment self-guards on source and never calls the API for a non-zentrades row", async () => {
  reset();
  const appt = { id: 1, job_id: 2, source: "inspectpoint", external_ref: "99812" };
  const result = await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "x" });
  assert.deepEqual(result, { skipped: "not_zentrades" });
  assert.equal(requestCalls.length, 0);
});

test("mirrorRescheduleAppointment treats a 200 whose echo does NOT reflect the sent time as a FAILURE (Gotcha 02)", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  // Echoes back the OLD time — server silently dropped/ignored the update.
  nextResponse = { ok: true, status: 200, data: { assignments: [{ id: 99812, startTime: "2026-09-12 18:00:00" }] } };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  const result = await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "echo_verification_failed");
  assert.equal(todoCalls.length, 1);
});

test("never sends `options` on any reschedule body — a full-blob overwrite would destroy signatureMediaId/approvedBy/etc.", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  nextResponse = { ok: true, status: 200, data: { assignments: [{ id: 99812, startTime: "2026-09-14 13:00:00" }] } };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z" });
  assert.equal("options" in requestCalls[0].body, false);
  assert.equal("isActive" in requestCalls[0].body, false);
  assert.equal("isDeleted" in requestCalls[0].body, false);
});

// ── mirrorCancelAppointment ──────────────────────────────────────────────────

test("mirrorCancelAppointment sends assignments.delete as OBJECTS carrying an id, never a bare id array", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  nextResponse = { ok: true, status: 200, data: { deletedAssignments: [{ id: 99812 }] } };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  const result = await provider.mirrorCancelAppointment(11, appt);
  assert.equal(result.ok, true);
  assert.deepEqual(requestCalls[0].body.assignments.delete, [{ id: 99812 }]);
});

test("mirrorCancelAppointment fails when the assignment id is absent from deletedAssignments", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  nextResponse = { ok: true, status: 200, data: { deletedAssignments: [] } };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  const result = await provider.mirrorCancelAppointment(11, appt);
  assert.equal(result.ok, false);
});

// ── mirrorCancelJob ──────────────────────────────────────────────────────────

test("mirrorCancelJob deletes every local ZenTrades visit on the ticket, regardless of their platform status", async () => {
  reset();
  jobIdByExternalRef["18423"] = 2;
  appointmentsByJob[2] = [
    { external_ref: "99812", status: "cancelled" },
    { external_ref: "99813", status: "cancelled" },
  ];
  nextResponse = { ok: true, status: 200, data: { deletedAssignments: [{ id: 99812 }, { id: 99813 }] } };
  const job = { source: "zentrades", external_ref: "18423" };
  const result = await provider.mirrorCancelJob(11, job);
  assert.equal(result.ok, true);
  const deleteList = requestCalls[0].body.assignments.delete;
  assert.deepEqual(new Set(deleteList.map((d) => d.id)), new Set([99812, 99813]));
});

test("mirrorCancelJob never sends cancelReason — neither call site provides one, and guessing would be dishonest", async () => {
  reset();
  jobIdByExternalRef["18423"] = 2;
  appointmentsByJob[2] = [{ external_ref: "99812", status: "cancelled" }];
  nextResponse = { ok: true, status: 200, data: { deletedAssignments: [{ id: 99812 }] } };
  await provider.mirrorCancelJob(11, { source: "zentrades", external_ref: "18423" });
  assert.equal("cancelReason" in requestCalls[0].body, false);
});

test("mirrorCancelJob is a clean no-op (not a failure) when there are no local visits to delete", async () => {
  reset();
  jobIdByExternalRef["18423"] = 2;
  appointmentsByJob[2] = [];
  const result = await provider.mirrorCancelJob(11, { source: "zentrades", external_ref: "18423" });
  assert.equal(result.ok, true);
  assert.equal(requestCalls.length, 0);
});

// ── mirrorCreateAppointment ──────────────────────────────────────────────────

test("mirrorCreateAppointment resolves the platform technician to its ZenTrades id and stamps back the NEW visit's id", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  techniciansById[55] = "507";
  appointmentsByJob[2] = [{ external_ref: "99812" }]; // one visit already known
  nextResponse = { ok: true, status: 200, data: { assignments: [{ id: 99812 }, { id: 88001 }] } }; // 88001 is new

  const appt = { id: 42, technician_id: 55 };
  const result = await provider.mirrorCreateAppointment(11, appt, 2, { scheduledStart: "2026-09-15T12:00:00.000Z", scheduledEnd: "2026-09-15T14:00:00.000Z" });

  assert.equal(result.ok, true);
  assert.equal(result.zentradesAssignmentId, "88001");
  const add = requestCalls[0].body.assignments.add[0];
  assert.equal(add.technicianId, 507);
  assert.equal(add.assignmentStatusId, 1);

  const stampCall = dbCalls.find((c) => /UPDATE appointments SET external_ref/.test(c.sql));
  assert.deepEqual(stampCall.params, ["88001", "zentrades", 42, 11]);
});

test("mirrorCreateAppointment refuses to guess a technician and raises a todo when none resolves", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  const appt = { id: 42, technician_id: 999 }; // not in techniciansById
  const result = await provider.mirrorCreateAppointment(11, appt, 2, { scheduledStart: "2026-09-15T12:00:00.000Z" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_technician");
  assert.equal(requestCalls.length, 0);
  assert.equal(todoCalls.length, 1);
});

// ── mirrorRescheduleJob ──────────────────────────────────────────────────────

test("mirrorRescheduleJob shifts every live visit to the new date, preserving each one's own LOCAL time-of-day and duration — but the wire value stays plain UTC", async () => {
  reset();
  appointmentsByJob[2] = [
    { external_ref: "99812", scheduled_start: new Date("2026-09-12T13:00:00.000Z"), scheduled_end: new Date("2026-09-12T15:00:00.000Z"), status: "scheduled" },
  ];
  // Original was 09:00 America/Toronto (13:00Z, EDT) — the NEW instant preserves
  // that same 09:00-local time-of-day on the new date, i.e. 2026-09-20T13:00:00Z,
  // which the wire format then renders as plain UTC (T/Z stripped), not
  // re-converted back to local.
  // Real echo shape is full ISO, not wall-clock — see ztInstantMinuteKey.
  nextResponse = { ok: true, status: 200, data: { assignments: [{ id: 99812, startTime: "2026-09-20T13:00:00.000Z" }] } };

  const job = { id: 2, source: "zentrades", external_ref: "18423" };
  const result = await provider.mirrorRescheduleJob(11, job, { scheduledDate: "2026-09-20" });

  assert.equal(result.ok, true);
  const update = requestCalls[0].body.assignments.update[0];
  assert.equal(update.startTime, "2026-09-20 13:00:00");
  assert.equal(update.endTime, "2026-09-20 15:00:00");
});

test("mirrorRescheduleJob is a clean skip when the job has no live (non-cancelled) local visits", async () => {
  reset();
  appointmentsByJob[2] = [];
  const job = { id: 2, source: "zentrades", external_ref: "18423" };
  const result = await provider.mirrorRescheduleJob(11, job, { scheduledDate: "2026-09-20" });
  assert.deepEqual(result, { skipped: "no_live_assignments" });
  assert.equal(requestCalls.length, 0);
});

// ── error-code branching ─────────────────────────────────────────────────────

test("E104 (overwrite conflict) fails immediately and is NEVER retried", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  let calls = 0;
  nextResponse = () => { calls++; return { ok: false, status: 500, data: { exception: { error: { code: "E104", description: "Visit details were updated by another user." } } } }; };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  const result = await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "E104");
  assert.equal(calls, 1, "must not retry an overwrite conflict");
  assert.match(todoCalls[0].metadata.error, /E104/);
});

test("E501 (database failure) is retried exactly once", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  let calls = 0;
  nextResponse = () => {
    calls++;
    if (calls === 1) return { ok: false, status: 500, data: { exception: { error: { code: "E501", description: "db error" } } } };
    return { ok: true, status: 200, data: { assignments: [{ id: 99812, startTime: "2026-09-14 13:00:00" }] } };
  };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  const result = await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z" });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test("a persistent E501 (fails twice) still gives up after the one retry, not a loop", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  let calls = 0;
  nextResponse = () => { calls++; return { ok: false, status: 500, data: { exception: { error: { code: "E501", description: "db error" } } } }; };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  const result = await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z" });
  assert.equal(result.ok, false);
  assert.equal(calls, 2, "exactly one retry, then stop");
});

test("E100 (validation) fails without retry and surfaces the description in the todo", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  let calls = 0;
  nextResponse = () => { calls++; return { ok: false, status: 500, data: { exception: { error: { code: "E100", description: "jobTypeId is required" } } } }; };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  const result = await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z" });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.match(todoCalls[0].metadata.error, /jobTypeId is required/);
});

test("every write-back request suppresses the client's generic api-error todo (the mirror raises its own richer one)", async () => {
  reset();
  jobRows[2] = { external_ref: "18423", source: "zentrades" };
  nextResponse = { ok: true, status: 200, data: { assignments: [{ id: 99812, startTime: "2026-09-14 13:00:00" }] } };
  const appt = { id: 1, job_id: 2, source: "zentrades", external_ref: "99812" };
  await provider.mirrorRescheduleAppointment(11, appt, { scheduledStart: "2026-09-14T13:00:00.000Z" });
  assert.equal(requestCalls[0].opts.suppressErrorTodo, true);
  assert.equal(requestCalls[0].opts.retryable, false, "a mutating write must never be retried blind by the generic client");
});

// ── notes ────────────────────────────────────────────────────────────────────

test("mirrorPostChatComment POSTs a public note to /api/note/ticket/create/v2", async () => {
  reset();
  jobRows[7] = { external_ref: "18423", source: "zentrades" };
  nextResponse = { ok: true, status: 200, data: { id: 3189254 } };
  const result = await provider.mirrorPostChatComment(11, { jobId: 7, summaryLines: ["Confirmed for Tuesday."], recipientName: "Jane" });
  assert.equal(result.ok, true);
  const call = requestCalls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/api/note/ticket/create/v2");
  assert.equal(call.body.ticketId, 18423);
  assert.equal(call.body.isPrivate, false, "notes are PUBLIC per product decision");
  assert.match(call.body.text, /Confirmed for Tuesday\./);
  assert.match(call.body.text, /Jane/);
});

test("mirrorPostChatComment skips cleanly when there's nothing to report", async () => {
  reset();
  const result = await provider.mirrorPostChatComment(11, { jobId: 7, summaryLines: [] });
  assert.deepEqual(result, { skipped: "nothing_reportable" });
  assert.equal(requestCalls.length, 0);
});

test("mirrorPostCallComment POSTs the call summary as a public note", async () => {
  reset();
  jobRows[7] = { external_ref: "18423", source: "zentrades" };
  nextResponse = { ok: true, status: 200, data: { id: 3189255 } };
  const result = await provider.mirrorPostCallComment(11, { scheduledCall: { job_id: 7 }, callSummary: "Customer confirmed by phone." });
  assert.equal(result.ok, true);
  assert.match(requestCalls[0].body.text, /Customer confirmed by phone\./);
});

test("a note POST that returns 200 with no id is treated as a failure", async () => {
  reset();
  jobRows[7] = { external_ref: "18423", source: "zentrades" };
  nextResponse = { ok: true, status: 200, data: {} };
  const result = await provider.mirrorPostChatComment(11, { jobId: 7, summaryLines: ["x"] });
  assert.equal(result.ok, false);
  assert.equal(todoCalls.length, 1);
});
