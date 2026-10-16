/**
 * POST /jobs/:id/refresh — the ↻ button on every job (docs/crm-sync-frontend.md §2).
 *
 * The provider re-reads the job's whole graph; services/job-refresh.js
 * snapshots that graph from the platform tables before and after and reports
 * what changed, field by field, across every entity tied to the job — not only
 * the job and its appointments.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

// A tiny model of the platform tables: `state.before` until the provider runs,
// `state.after` once it has.
const base = () => ({
  job: { id: 7, company_id: 16, source: "servicetrade", external_ref: "J1", customer_id: 3, location_id: 4,
         primary_contact_id: 50, status: "scheduled", title: "Annual inspection", scheduled_date: "2026-10-20" },
  appointments: [{ id: 70, job_id: 7, status: "scheduled", scheduled_start: new Date("2026-10-20T14:00:00Z"), scheduled_end: new Date("2026-10-20T16:00:00Z") }],
  technicians: [{ appointment_id: 70, id: 9, first_name: "Sam", last_name: "Tech" }],
  services: [],
  customers: [{ id: 3, full_name: "Acme", phone: "+14155550100" }],
  locations: [{ id: 4, name: "Acme HQ", phone: "+14155550100" }],
  contacts: [{ id: 50, first_name: "Old", last_name: "Contact", phone: "+14155550111", status: "public" }],
  deficiencies: [],
  serviceRequests: [],
  jobNotes: [],
  apptNotes: [],
});
const state = { phase: "before", before: base(), after: base() };
const tables = () => state[state.phase];

stub("db", {
  query: async (sql) => {
    const t = tables();
    if (/SELECT id, source, external_ref/.test(sql)) return { rows: t.job ? [t.job] : [] };
    if (/SELECT \* FROM jobs/.test(sql)) return { rows: t.job ? [t.job] : [] };
    if (/FROM appointment_technicians/.test(sql)) return { rows: t.technicians };
    if (/FROM appointment_services/.test(sql)) return { rows: t.services };
    if (/SELECT \* FROM appointments/.test(sql)) return { rows: t.appointments };
    if (/FROM customers/.test(sql)) return { rows: t.customers };
    if (/FROM locations/.test(sql)) return { rows: t.locations };
    if (/FROM contacts c/.test(sql)) return { rows: t.contacts };
    if (/FROM deficiencies/.test(sql)) return { rows: t.deficiencies };
    if (/FROM service_requests/.test(sql)) return { rows: t.serviceRequests };
    if (/FROM job_notes/.test(sql)) return { rows: t.jobNotes };
    if (/FROM appointment_notes/.test(sql)) return { rows: t.apptNotes };
    return { rows: [] };
  },
});

let providerImpl;
const providerCalls = [];
stub("services/crm", {
  getProvider: (slug) => {
    if (slug !== "servicetrade" && slug !== "inspectpoint") throw new Error(`Unknown CRM provider: ${slug}`);
    if (slug === "inspectpoint") return {};   // no refreshJob yet
    return { refreshJob: async (companyId, job) => { providerCalls.push({ companyId, job }); return providerImpl(); } };
  },
});

const jobRefresh = require("../src/services/job-refresh");

function reset() {
  state.phase = "before";
  state.before = base();
  state.after = base();
  providerCalls.length = 0;
  providerImpl = async () => { state.phase = "after"; return { ok: true, incomplete: [] }; };
  jobRefresh._reset();
}

test("nothing changed in the CRM → changed: false, no changes", async () => {
  reset();
  const r = await jobRefresh.refreshJob(16, 7);
  assert.equal(r.changed, false);
  assert.deepEqual(r.changes, []);
  assert.equal(providerCalls[0].job.external_ref, "J1");
});

test("changes across EVERY entity tied to the job are reported, field by field", async () => {
  reset();
  const a = state.after;
  a.job.status = "completed";
  a.appointments[0].scheduled_start = new Date("2026-10-20T18:00:00Z");
  a.appointments.push({ id: 71, job_id: 7, status: "scheduled", scheduled_start: new Date("2026-10-27T14:00:00Z") });
  a.technicians = [{ appointment_id: 70, id: 10, first_name: "Ria", last_name: "New" }];
  a.customers[0].phone = "+14155550199";
  a.locations[0].name = "Acme Campus";
  a.contacts = [{ id: 51, first_name: "Dana", last_name: "Lee", status: "public" }];
  a.deficiencies = [{ id: 300, name: "Deficient - Street Side", status: "verified", is_resolved: false }];
  a.serviceRequests = [{ id: 400, description: "Annual sprinkler test", status: "open" }];
  a.jobNotes = [{ type: "jobComments", text: "Gate code 4411" }];

  const r = await jobRefresh.refreshJob(16, 7);
  const has = (m) => r.changes.some((c) => Object.entries(m).every(([k, v]) => JSON.stringify(c[k]) === JSON.stringify(v)));

  assert.equal(r.changed, true);
  assert.ok(has({ entity: "job", action: "updated", field: "status", from: "scheduled", to: "completed" }));
  assert.ok(has({ entity: "appointment", id: 70, action: "updated", field: "scheduled_start",
    from: "2026-10-20T14:00:00.000Z", to: "2026-10-20T18:00:00.000Z" }), "dates compare and report as ISO");
  assert.ok(has({ entity: "appointment", id: 71, action: "created" }));
  assert.ok(has({ entity: "technician", id: 9, action: "removed", label: "Sam Tech", appointment_id: 70 }));
  assert.ok(has({ entity: "technician", id: 10, action: "created", label: "Ria New" }));
  assert.ok(has({ entity: "customer", action: "updated", field: "phone", to: "+14155550199" }));
  assert.ok(has({ entity: "location", action: "updated", field: "name", from: "Acme HQ", to: "Acme Campus" }));
  assert.ok(has({ entity: "contact", id: 50, action: "removed", label: "Old Contact" }), "unlinked / deactivated");
  assert.ok(has({ entity: "contact", id: 51, action: "created", label: "Dana Lee" }));
  assert.ok(has({ entity: "deficiency", id: 300, action: "created", label: "Deficient - Street Side" }));
  assert.ok(has({ entity: "service_request", id: 400, action: "created" }));
  assert.ok(has({ entity: "note", action: "created", label: "Gate code 4411" }));
});

test("one comment filed under two ServiceTrade note categories is ONE note change", async () => {
  reset();
  state.after.jobNotes = [
    { type: "jobComments", text: "Clara refresh test" },
    { type: "locTechComments", text: "Clara refresh test" },
  ];
  const r = await jobRefresh.refreshJob(16, 7);
  assert.equal(r.changes.filter((c) => c.entity === "note").length, 1);
});

test("bookkeeping-only differences (timestamps, payloads) are not changes", async () => {
  reset();
  state.after.job.updated_at = new Date();
  state.after.job.additional_information = { anything: true };
  const r = await jobRefresh.refreshJob(16, 7);
  assert.equal(r.changed, false);
});

test("csv / manual jobs can't be refreshed; a CRM without refreshJob says so", async () => {
  reset();
  state.before.job.source = "csv";
  await assert.rejects(jobRefresh.refreshJob(16, 7), { code: "not_syncable" });
  reset();
  state.before.job.source = "inspectpoint";
  await assert.rejects(jobRefresh.refreshJob(16, 7), { code: "not_supported" });
  reset();
  state.before.job = null;
  await assert.rejects(jobRefresh.refreshJob(16, 7), { code: "not_found" });
});

test("the provider's failure codes pass through (deleted upstream, reconnect)", async () => {
  reset();
  providerImpl = async () => ({ ok: false, code: "not_in_crm" });
  await assert.rejects(jobRefresh.refreshJob(16, 7), { code: "not_in_crm" });
  reset();
  providerImpl = async () => ({ ok: false, code: "reconnect_required", error: "session expired" });
  await assert.rejects(jobRefresh.refreshJob(16, 7), { code: "reconnect_required" });
});

test("a second press within 10 s is refused with retry_after_s; a press during a refresh joins it", async () => {
  reset();
  let release;
  providerImpl = () => new Promise((resolve) => { release = () => { state.phase = "after"; resolve({ ok: true }); }; });
  const first = jobRefresh.refreshJob(16, 7);
  const joined = jobRefresh.refreshJob(16, 7);
  await new Promise((r) => setImmediate(r));
  release();
  assert.equal(await joined, await first, "the same in-flight result, not a second CRM read");
  assert.equal(providerCalls.length, 1);
  await assert.rejects(jobRefresh.refreshJob(16, 7), (err) => err.code === "too_soon" && err.retry_after_s > 0);
});

test("a partial provider read (some entity fetch incomplete) is flagged", async () => {
  reset();
  providerImpl = async () => { state.phase = "after"; return { ok: true, incomplete: ["jobs"] }; };
  assert.equal((await jobRefresh.refreshJob(16, 7)).partial, true);
});

// ── the route ──────────────────────────────────────────────────────────────

test("POST /jobs/:id/refresh returns the job + changes, and maps refresh errors to HTTP statuses", async () => {
  let impl = async () => ({ changed: true, changes: [{ entity: "job", action: "updated", field: "status" }], refreshed_at: "t", partial: false });
  stub("services/job-refresh", {
    RefreshError: jobRefresh.RefreshError,
    refreshJob: (...a) => impl(...a),
  });
  stub("db/jobs", { JOB_VIEWS: ["current", "past", "all"], getJobById: async () => ({ id: 7, title: "Annual inspection" }) });
  stub("auth", {
    authenticate: (req, _res, next) => { req.user = { userId: 1, companyId: 16, role: "admin" }; next(); },
    getCompanyId: (req) => req.user.companyId,
  });
  stub("utils/timezone", { getCompanyTimezone: async () => "America/Chicago", localToUTC: (x) => x, localizeFields: (o) => o, localizeRows: (r) => r });
  stub("services/job-confirmation-status", { syncJobConfirmationStatus: async () => {} });
  stub("services/scheduler", {});
  stub("db/call-settings", { getByCompanyId: async () => ({}) });
  delete require.cache[require.resolve("../src/routes/jobs")];
  const app = express();
  app.use((req, _res, next) => { req.user = { userId: 1, companyId: 16, role: "admin", permissions: [] }; next(); });
  app.use("/jobs", require("../src/routes/jobs"));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/jobs/7/refresh`;
  try {
    let res = await fetch(url, { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.job.id, 7);
    assert.equal(body.changed, true);

    for (const [code, status, extra] of [
      ["not_in_crm", 404], ["not_syncable", 400], ["not_supported", 501],
      ["too_soon", 429, { retry_after_s: 7 }], ["reconnect_required", 409], ["crm_unavailable", 502],
    ]) {
      impl = async () => { throw new jobRefresh.RefreshError(code, "x", extra || {}); };
      res = await fetch(url, { method: "POST" });
      assert.equal(res.status, status, code);
      const b = await res.json();
      assert.equal(b.code, code);
      if (extra) assert.equal(b.retry_after_s, 7);
    }
  } finally {
    server.close();
  }
});
