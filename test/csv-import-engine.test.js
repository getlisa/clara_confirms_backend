/**
 * engines/csv-import + services/crm/csv/provider — the pieces that only make
 * sense against the rest of the platform.
 *
 * Two things here are guarding against specific, verified failures rather than
 * hypotheticals:
 *
 *  - CsvProvider.syncAll must NOT throw. `/admin/crm-sync` runs every two
 *    hours and, for each registered provider, calls syncAll on every company
 *    holding an active integration row. The sentinel `auth_code='csv'` that
 *    makes resolveSlugForCompany return "csv" therefore puts CSV companies in
 *    that loop, and CrmProvider's base syncAll throws.
 *  - The engine must run in the FOREGROUND. crm-sync fires its work
 *    un-awaited, which is safe only because a cron retries it; on Vercel an
 *    un-awaited import can be frozen mid-flight and nothing ever resumes it
 *    (engines GC only marks a silent run failed).
 */

process.env.TZ = "Asia/Kolkata";

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

// ── Fakes ───────────────────────────────────────────────────────────────────

const upserts = [];
const queries = [];
stub("db", {
  query: async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM technicians/.test(sql)) return { rows: technicianRows };
    return { rows: [] };
  },
  bulkUpsertByExternalRef: async (table, fields, rows) => { upserts.push({ table, fields, rows }); return rows.length; },
  // Every entity resolves to a synthetic id so FK wiring can be asserted.
  fetchExternalRefMap: async (_companyId, table) => {
    const written = upserts.filter((u) => u.table === table).flatMap((u) => u.rows);
    return new Map(written.map((r, i) => [r.externalRef, `${table}-${i + 1}`]));
  },
});

let technicianRows = [];

const importRecords = new Map();
const marks = [];
const stagedRows = [];
stub("db/csv-imports", {
  getById: async (id) => importRecords.get(String(id)) || null,
  markRunning: async (id, companyId, runId) => { marks.push({ mark: "running", id: String(id), runId }); },
  markCompleted: async (id, companyId, summary) => { marks.push({ mark: "completed", id: String(id), summary }); },
  markFailed: async (id, companyId, error) => { marks.push({ mark: "failed", id: String(id), error }); },
  replaceRows: async (importId, companyId, rows) => { stagedRows.push({ importId, companyId, rows }); return rows.length; },
});

const events = [];
stub("engines/core/db", {
  createRun: async ({ kind, companyId }) => ({ id: 42, kind, company_id: companyId, started_at: new Date().toISOString() }),
  appendEvent: async (_id, evt) => { events.push(evt); return { ...evt, seq: events.length }; },
  setStatus: async (_id, status, extra) => { events.push({ type: "__status__", status, ...extra }); },
});

stub("utils/timezone", {
  getCompanyTimezone: async () => "America/New_York",
  localToUTC: (s) => new Date(`${s.replace(/Z$/, "")}Z`).toISOString(),
  toLocalDateOnly: (iso) => String(iso).slice(0, 10),
});

const csvImportEngine = require("../src/engines/csv-import");
const csvProvider = require("../src/services/crm/csv/provider");

function seedImport(csv, { id = "1", filename = "jobs.csv" } = {}) {
  importRecords.set(id, { id, companyId: 7, filename, rawContent: csv, status: "pending" });
  return id;
}

function reset() {
  upserts.length = 0; queries.length = 0; events.length = 0; marks.length = 0;
  stagedRows.length = 0; importRecords.clear(); technicianRows = [];
}

const GOOD_CSV =
  "Work Order,Customer,Phone,Scheduled,Technician\n" +
  "WO-1,Acme Inc,5551234567,2026-03-04 14:00,Jane Smith\n" +
  "WO-2,Beta LLC,5559876543,2026-03-05 09:00,\n";

// ── The provider ────────────────────────────────────────────────────────────

test("CsvProvider.syncAll resolves instead of throwing — the crm-sync cron calls it every 2 hours", async () => {
  // CrmProvider's base syncAll throws; inheriting it would log an error per
  // CSV company per cron tick, forever.
  const result = await csvProvider.syncAll(7);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, "csv_has_no_remote_to_sync");
  await assert.doesNotReject(() => csvProvider.syncEntity(7, "jobs"));
});

test("every write-back mirror on CsvProvider is a no-op — there is no CRM to write to", async () => {
  const appt = { source: "csv", external_ref: "WO-1", job_id: 1 };
  for (const [method, args] of [
    ["mirrorRescheduleAppointment", [7, appt, {}]],
    ["mirrorCancelAppointment", [7, appt, {}]],
    ["mirrorCancelJob", [7, appt, {}]],
    ["mirrorPostChatComment", [7, { jobId: 1, summaryLines: ["x"] }]],
    ["mirrorPostCallComment", [7, { scheduledCall: { job_id: 1 } }]],
  ]) {
    assert.deepEqual(await csvProvider[method](...args), { skipped: "not_supported" }, `${method} must no-op`);
  }
});

// ── The engine ──────────────────────────────────────────────────────────────

test("a good file writes every entity in FK order and reports what it did", async () => {
  reset();
  seedImport(GOOD_CSV);
  const engine = await csvImportEngine.start({ companyId: 7, importId: "1" });

  // An entity set with nothing in it issues no query at all, so only the
  // tables that actually had rows appear here — what matters is their ORDER.
  assert.deepEqual(upserts.map((u) => u.table), ["customers", "jobs", "appointments"],
    "customers must be written before the jobs that reference them, and jobs before appointments");
  assert.equal(upserts.find((u) => u.table === "customers").rows.length, 2);
  assert.equal(upserts.find((u) => u.table === "appointments").rows.length, 2);
  assert.equal(upserts.some((u) => u.table === "locations"), false, "no address columns, so no invented locations");

  const completed = marks.find((m) => m.mark === "completed");
  assert.equal(completed.summary.importedRows, 2);
  assert.equal(completed.summary.errorRows, 0);
  assert.equal(engine.kind, "csv_import");
});

test("start() returns only once the work is DONE — an un-awaited run would be frozen by the platform and never resumed", async () => {
  reset();
  seedImport(GOOD_CSV);
  await csvImportEngine.start({ companyId: 7, importId: "1" });
  // By the time start() resolves the terminal event must already be recorded.
  assert.ok(events.some((e) => e.type === "done"), "the run must be finished, not merely scheduled");
  assert.ok(marks.some((m) => m.mark === "completed"));
});

test("appointments are linked to their job, and a technician is matched by name when one exists", async () => {
  reset();
  technicianRows = [{ id: 900, first_name: "Jane", last_name: "Smith" }];
  seedImport(GOOD_CSV);
  await csvImportEngine.start({ companyId: 7, importId: "1" });

  const appts = upserts.find((u) => u.table === "appointments").rows;
  assert.ok(appts.every((a) => a.jobId != null), "every appointment must resolve a job or it is invisible to the sweep");
  assert.equal(appts[0].technicianId, 900, "a name that matches the roster is attributed");
  assert.equal(appts[1].technicianId, null, "an absent technician leaves the visit unattributed, not failed");
});

test("an unmatched technician name does NOT create a technician — a typo must not pollute the roster", async () => {
  reset();
  technicianRows = [];
  seedImport(GOOD_CSV);
  await csvImportEngine.start({ companyId: 7, importId: "1" });
  assert.equal(upserts.some((u) => u.table === "technicians"), false);
  assert.equal(upserts.find((u) => u.table === "appointments").rows[0].technicianId, null);
});

test("bad rows are reported per-row while the good ones still import", async () => {
  reset();
  seedImport(
    "Work Order,Customer,Phone,Scheduled\n" +
    "WO-1,Acme Inc,5551234567,2026-03-04 14:00\n" +
    "WO-2,Broken Co,not-a-phone,2026-03-05 09:00\n"
  );
  await csvImportEngine.start({ companyId: 7, importId: "1" });

  const completed = marks.find((m) => m.mark === "completed");
  assert.equal(completed.summary.importedRows, 1);
  assert.equal(completed.summary.errorRows, 1);
  assert.match(completed.summary.errors[0].message, /phone number/);
});

test("a whole-file rejection marks the import failed with the reason, and writes nothing", async () => {
  reset();
  seedImport("Customer,Phone,Scheduled\nAcme,5551234567,2026-03-04\n"); // no reference column
  const engine = await csvImportEngine.start({ companyId: 7, importId: "1" });

  assert.equal(upserts.length, 0, "nothing may be written when the file is rejected");
  const failed = marks.find((m) => m.mark === "failed");
  assert.match(failed.error, /work order \/ reference number/);
  assert.ok(events.some((e) => e.type === "failed"), "the engine run must also record the failure");
  assert.equal(engine.kind, "csv_import");
});

test("progress is emitted as real engine states, so the existing SSE route can stream it unchanged", async () => {
  reset();
  seedImport(GOOD_CSV);
  await csvImportEngine.start({ companyId: 7, importId: "1" });
  // transition() writes type:"state"; finish() writes its own type:"done".
  const states = events.filter((e) => e.type === "state").map((e) => e.state);
  assert.deepEqual(states, [
    "parsing", "mapping", "staging", "writing_customers", "writing_locations",
    "writing_contacts", "writing_jobs", "writing_appointments",
  ]);
  assert.ok(events.some((e) => e.type === "done"), "and a terminal done event");
  // Every entity stage reports a count, including the ones with nothing to do,
  // so a progress UI can show them all rather than silently skipping two.
  const done = events.filter((e) => e.type === "entity_done").map((e) => e.payload.entity);
  assert.deepEqual(done, ["csv_import_rows", "customers", "locations", "contacts", "jobs", "appointments"]);
});

// ── The raw layer ───────────────────────────────────────────────────────────

test("every row is staged to the raw layer BEFORE anything reaches the platform tables", async () => {
  reset();
  seedImport(GOOD_CSV);
  await csvImportEngine.start({ companyId: 7, importId: "1" });

  assert.equal(stagedRows.length, 1, "staged in one replace, not appended per row");
  assert.equal(stagedRows[0].rows.length, 2);
  const staged = stagedRows[0].rows[0];
  assert.equal(staged.rowNumber, 2, "row 1 is the header, so the first data row is 2");
  assert.equal(staged.reference, "WO-1");
  assert.deepEqual(staged.payload, {
    "Work Order": "WO-1", Customer: "Acme Inc", Phone: "5551234567",
    Scheduled: "2026-03-04 14:00", Technician: "Jane Smith",
  }, "the payload is the RAW cells, exactly as read");
  assert.ok(staged.mapped, "a good row carries its typed interpretation alongside the raw cells");
  assert.equal(staged.error, null);
});

test("a row that fails to map is STILL staged, carrying its original cells and the reason", async () => {
  reset();
  seedImport(
    "Work Order,Customer,Phone,Scheduled\n" +
    "WO-1,Acme Inc,5551234567,2026-03-04 14:00\n" +
    "WO-2,Broken Co,not-a-phone,2026-03-05 09:00\n"
  );
  await csvImportEngine.start({ companyId: 7, importId: "1" });

  const rows = stagedRows[0].rows;
  assert.equal(rows.length, 2, "the raw layer mirrors the whole file, not just the usable rows");
  const bad = rows.find((r) => r.rowNumber === 3);
  assert.equal(bad.payload.Phone, "not-a-phone", "the original cell must survive for the error report");
  assert.match(bad.error, /phone number/);
  assert.equal(bad.mapped, null);
});

test("the engine APPLIES the mapping stored on the import — a mapped file must not be re-derived from scratch", async () => {
  reset();
  // Headers alias matching cannot resolve. An earlier version accepted the
  // mapping at the route, stored it, then re-mapped without it inside the run —
  // so every mapped import failed with the very error the mapping fixed.
  const csv = "Appointment Ref,Client Company,Contact Mobile,Visit Day\nAPT-1,Northgate Retail,5559876543,2026-10-14\n";
  importRecords.set("1", {
    id: "1", companyId: 7, filename: "real.csv", rawContent: csv, status: "pending",
    columnMapping: { reference: "Appointment Ref", customerName: "Client Company", phone: "Contact Mobile", scheduledDate: "Visit Day" },
  });

  await csvImportEngine.start({ companyId: 7, importId: "1" });

  const completed = marks.find((m) => m.mark === "completed");
  assert.ok(completed, "the run must succeed using the stored mapping");
  assert.equal(completed.summary.importedRows, 1);
  assert.equal(upserts.find((u) => u.table === "appointments").rows[0].externalRef, "APT-1");
});

test("an explicit mapping overrides the stored one, which is how a mis-mapped import gets corrected", async () => {
  reset();
  const csv = "Appointment Ref,Client Company,Contact Mobile,Visit Day\nAPT-1,Northgate Retail,5559876543,2026-10-14\n";
  importRecords.set("1", {
    id: "1", companyId: 7, filename: "real.csv", rawContent: csv, status: "completed",
    columnMapping: { reference: "Visit Day", customerName: "Client Company", phone: "Contact Mobile", scheduledDate: "Appointment Ref" },
  });

  await csvImportEngine.start({ companyId: 7, importId: "1", mapping: {
    reference: "Appointment Ref", customerName: "Client Company", phone: "Contact Mobile", scheduledDate: "Visit Day",
  } });

  assert.equal(upserts.find((u) => u.table === "appointments").rows[0].externalRef, "APT-1");
});

test("a row that imports with a warning is reported without being counted as an error", async () => {
  reset();
  seedImport(
    "Work Order,Customer,Phone,Email,Scheduled\n" +
    "WO-1,Acme,555-0142,ops@acme.example,2026-03-04 14:00\n"
  );
  await csvImportEngine.start({ companyId: 7, importId: "1" });

  const completed = marks.find((m) => m.mark === "completed");
  assert.equal(completed.summary.importedRows, 1);
  assert.equal(completed.summary.errorRows, 0);
  const warned = events.filter((e) => e.type === "warning");
  assert.ok(warned.some((w) => /area code/.test(w.payload.message)), "the office is told why this customer is email-only");
});

test("a purged file fails the RUN with an actionable message, without rewriting the import's own history", async () => {
  reset();
  // An old, successful import whose file the 30-day sweep has since cleared.
  importRecords.set("1", { id: "1", companyId: 7, filename: "old.csv", rawContent: null, status: "completed" });
  await csvImportEngine.start({ companyId: 7, importId: "1" });

  const failure = events.find((e) => e.type === "failed");
  assert.match(failure.payload.error, /no longer stored.*30 days/i);
  assert.equal(stagedRows.length, 0, "nothing may be staged from a file we no longer have");
  // Crucially: the archive row keeps saying "completed". Re-running something
  // whose file has expired must not turn a historical success into a failure.
  assert.equal(marks.some((m) => m.mark === "failed"), false);
  assert.equal(marks.some((m) => m.mark === "running"), false, "and it is never claimed in the first place");
});
