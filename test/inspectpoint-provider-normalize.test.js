/**
 * crm/inspectpoint/provider.js — the normalize orchestration: FK resolution
 * order, per-building primary-contact derivation and its propagation from
 * contacts -> locations -> jobs, system-technician filtering, and the
 * junction writes. Fake db throughout, following the exact convention
 * test/junction-replace-set.test.js already established for this kind of test.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

// ── A db stub that models junction tables as real sets (so DELETE's effect is
// observable) plus a spy on bulkUpsertByExternalRef (so normalize's resolved
// FK values are directly assertable), matching junction-replace-set.test.js. ──

const junctionTables = new Map(); // table -> Set("a|b")
const upsertCalls = [];           // {table, fields, argsList}
let rawRows = {};
let refMaps = {};
let locationRowsForJobPass = [];

function tableOf(name) {
  if (!junctionTables.has(name)) junctionTables.set(name, new Set());
  return junctionTables.get(name);
}

function runDelete(sql, params) {
  const table = sql.match(/DELETE FROM (\w+)/)[1];
  const [parents, flatA, flatB] = params;
  const keep = new Set(flatA.map((a, i) => `${a}|${flatB[i]}`));
  const set = tableOf(table);
  for (const row of [...set]) {
    const [a] = row.split("|");
    if (parents.map(String).includes(a) && !keep.has(row)) set.delete(row);
  }
  return { rows: [], rowCount: 0 };
}

function runInsert(sql, params) {
  const table = sql.match(/INSERT INTO (\w+)/)[1];
  const set = tableOf(table);
  for (let i = 0; i < params.length; i += 2) set.add(`${params[i]}|${params[i + 1]}`);
  return { rows: [], rowCount: 0 };
}

stub("db", {
  query: async (sql, params) => {
    if (/^\s*DELETE FROM/.test(sql)) return runDelete(sql, params);
    if (/^\s*INSERT INTO/.test(sql)) return runInsert(sql, params);
    if (/SELECT id, primary_contact_id FROM locations/.test(sql)) return { rows: locationRowsForJobPass };
    return { rows: [] };
  },
  fetchAllByCompanyChunked: async (_companyId, table) => rawRows[table] || [],
  fetchExternalRefMap: async (_companyId, table, source) => {
    assert.equal(source, "inspectpoint", `fetchExternalRefMap for ${table} must be scoped to source='inspectpoint'`);
    return refMaps[table] || new Map();
  },
  bulkUpsertByExternalRef: async (table, fields, argsList) => {
    upsertCalls.push({ table, fields, argsList });
    return argsList.length;
  },
});

const provider = require("../src/services/crm/inspectpoint/provider");

function reset() {
  junctionTables.clear();
  upsertCalls.length = 0;
  rawRows = {};
  refMaps = {};
  locationRowsForJobPass = [];
}

function upsertFor(table) {
  return upsertCalls.find((c) => c.table === table);
}

function seed() {
  rawRows.inspectpoint_customers = [{ inspectpoint_id: 1, is_active: true, payload: { name: "Acme" } }];

  rawRows.inspectpoint_technicians = [
    { inspectpoint_id: 200, is_active: true, payload: { name: "Ryan Brooks" } },
    { inspectpoint_id: 201, is_active: true, payload: { name: "System Bot", system: true } },
  ];

  // Building 10: contact 100 has the 'scheduling' role -> should win as primary.
  // Building 11: contact 101 is the SOLE contact with no special role -> wins via the sole-contact rule.
  rawRows.inspectpoint_contacts = [
    { inspectpoint_id: 100, inspectpoint_customer_id: 1, payload: { name: "Dana Reed", buildings: [{ id: 10, roles: ["scheduling"] }] } },
    { inspectpoint_id: 102, inspectpoint_customer_id: 1, payload: { name: "Other Person", buildings: [{ id: 10, roles: ["billing"] }] } },
    { inspectpoint_id: 101, inspectpoint_customer_id: 1, payload: { name: "Jordan Smith", buildings: [{ id: 11, roles: [] }] } },
  ];

  rawRows.inspectpoint_locations = [
    { inspectpoint_id: 10, inspectpoint_customer_id: 1, payload: { name: "Building A", account_id: 1 } },
    { inspectpoint_id: 11, inspectpoint_customer_id: 1, payload: { name: "Building B", account_id: 1 } },
  ];

  rawRows.inspectpoint_jobs = [
    { inspectpoint_id: 1000, inspectpoint_location_id: 10, inspectpoint_customer_id: 1, inspectpoint_technician_id: 200, status_code: "scheduled", scheduled_at: null, due_date: null, payload: {} },
  ];

  rawRows.inspectpoint_appointments = [
    { inspectpoint_id: 5000, inspectpoint_job_id: 1000, inspectpoint_technician_id: 200, visit_status: "scheduled", scheduled_date: "2026-09-10T13:00:00-04:00", payload: {} },
  ];

  refMaps.customers = new Map([["1", 501]]);
  // Populated progressively as each pass "completes" — locations pass reads
  // the contacts map, so it must already reflect the contacts upsert.
  refMaps.contacts = new Map([["100", 601], ["101", 602], ["102", 603]]);
  refMaps.locations = new Map([["10", 701], ["11", 702]]);
  refMaps.technicians = new Map([["200", 801]]);
  refMaps.jobs = new Map([["1000", 901]]);

  // What _normalizeJobs reads back after locations are upserted — building 10's
  // primary contact resolved to platform id 601 (Dana), building 11's to 602 (Jordan).
  locationRowsForJobPass = [
    { id: 701, primary_contact_id: 601 },
    { id: 702, primary_contact_id: 602 },
  ];
}

// ── Ordering & FK resolution ─────────────────────────────────────────────────

test("normalizeAll: upsert order satisfies every FK dependency, ending with appointment_services", async () => {
  reset();
  seed();
  await provider.normalizeAll(9);
  const order = upsertCalls.map((c) => c.table);
  assert.deepEqual(order, ["customers", "contacts", "technicians", "locations", "service_lines", "jobs", "appointments", "appointment_services"]);
  // The two load-bearing constraints, asserted by meaning rather than by the
  // literal list above so a future reorder fails for a readable reason:
  // appointment_services needs appointment ids, job ids AND service line ids.
  assert.ok(order.indexOf("service_lines") < order.indexOf("appointment_services"));
  assert.ok(order.indexOf("appointments") < order.indexOf("appointment_services"));
  assert.ok(order.indexOf("jobs") < order.indexOf("appointments"));
});

test("normalizeAll: resolves customer_id/location_id/technician_id on jobs via the external-ref maps", async () => {
  reset();
  seed();
  await provider.normalizeAll(9);
  const jobRow = upsertFor("jobs").argsList[0];
  assert.equal(jobRow.customerId, 501);
  assert.equal(jobRow.locationId, 701);
  assert.equal(jobRow.technicianId, 801);
});

test("normalizeAll: appointments resolve jobId/technicianId via the external-ref maps", async () => {
  reset();
  seed();
  await provider.normalizeAll(9);
  const apptRow = upsertFor("appointments").argsList[0];
  assert.equal(apptRow.jobId, 901);
  assert.equal(apptRow.technicianId, 801);
});

// ── System technician filtering ──────────────────────────────────────────────

test("normalizeAll: system:true technicians are excluded from the upsert entirely", async () => {
  reset();
  seed();
  await provider.normalizeAll(9);
  const technicianRows = upsertFor("technicians").argsList;
  assert.equal(technicianRows.length, 1);
  assert.equal(technicianRows[0].externalRef, "200");
});

// ── Primary-contact derivation and propagation ──────────────────────────────

test("normalizeAll: a contact with the 'scheduling' role wins as primary for that building", async () => {
  reset();
  seed();
  await provider.normalizeAll(9);
  const contactRows = upsertFor("contacts").argsList;
  const dana = contactRows.find((c) => c.externalRef === "100");
  const other = contactRows.find((c) => c.externalRef === "102");
  assert.equal(dana.contactRole, "primary");
  assert.equal(other.contactRole, "general", "the non-scheduling contact on the same building must not also be marked primary");
});

test("normalizeAll: the sole contact on a building wins as primary even with no special role", async () => {
  reset();
  seed();
  await provider.normalizeAll(9);
  const jordan = upsertFor("contacts").argsList.find((c) => c.externalRef === "101");
  assert.equal(jordan.contactRole, "primary");
});

test("normalizeAll: locations resolve primaryContactId to the derived winner's PLATFORM id, not the external ref", async () => {
  reset();
  seed();
  await provider.normalizeAll(9);
  const locationRows = upsertFor("locations").argsList;
  const buildingA = locationRows.find((l) => l.externalRef === "10");
  const buildingB = locationRows.find((l) => l.externalRef === "11");
  assert.equal(buildingA.primaryContactId, 601); // Dana's platform id
  assert.equal(buildingB.primaryContactId, 602); // Jordan's platform id
});

test("normalizeAll: a job's primary_contact_id mirrors its building's primary contact", async () => {
  reset();
  seed();
  await provider.normalizeAll(9);
  const jobRow = upsertFor("jobs").argsList[0];
  assert.equal(jobRow.primaryContactId, 601); // job is at building 10
});

test("normalizeAll: a building with no contacts at all gets primaryContactId=null, not an error", async () => {
  reset();
  seed();
  rawRows.inspectpoint_contacts = []; // no contacts reference any building
  locationRowsForJobPass = [{ id: 701, primary_contact_id: null }, { id: 702, primary_contact_id: null }];
  await provider.normalizeAll(9);
  const locationRows = upsertFor("locations").argsList;
  assert.ok(locationRows.every((l) => l.primaryContactId == null));
});

// ── Junction writes ──────────────────────────────────────────────────────────

test("normalizeAll: writes contact_locations and contact_companies junctions", async () => {
  reset();
  seed();
  await provider.normalizeAll(9);
  assert.ok(tableOf("contact_locations").has("601|701"), "Dana (601) linked to Building A (701)");
  assert.ok(tableOf("contact_companies").has("601|501"), "Dana (601) linked to Acme (501)");
  assert.ok(tableOf("contact_locations").has("602|702"), "Jordan (602) linked to Building B (702)");
});

// ── The confirmation-status-preserving updateExpr (real SQL, not stubbed) ───

test("APPOINTMENT_FIELDS.status has an updateExpr that preserves confirmed/rescheduled/cancelled through a re-sync", async () => {
  const { APPOINTMENT_FIELDS } = provider.FIELDS;
  const statusField = APPOINTMENT_FIELDS.find((f) => f.column === "status");
  assert.ok(statusField.updateExpr, "a plain overwrite here would silently undo real customer confirmations on every sync");
  assert.match(statusField.updateExpr, /CASE WHEN appointments\.status IN \('confirmed','rescheduled','cancelled'\)/);
  assert.match(statusField.updateExpr, /ELSE EXCLUDED\.status END/);
});


test("APPOINTMENT_FIELDS writes scheduled_start/scheduled_end — normalizeAppointment produced them all along, but with no descriptor every synced appointment landed with a NULL time", () => {
  const { APPOINTMENT_FIELDS } = provider.FIELDS;
  const start = APPOINTMENT_FIELDS.find((f) => f.column === "scheduled_start");
  const end = APPOINTMENT_FIELDS.find((f) => f.column === "scheduled_end");
  assert.ok(start, "scheduled_start must be written — the confirmation agent, the scheduler sweep and technician-availability all read it");
  assert.equal(start.key, "scheduledStart");
  assert.ok(end, "scheduled_end must be written — it is what the appointments overlap constraint and slot search use");
  assert.equal(end.key, "scheduledEnd");
});

test("JOB_FIELDS writes the scheduled window on both ends", () => {
  const { JOB_FIELDS } = provider.FIELDS;
  assert.ok(JOB_FIELDS.find((f) => f.column === "scheduled_window_start"));
  assert.ok(JOB_FIELDS.find((f) => f.column === "scheduled_window_end"));
});

test("normalizeAll: primaryContactId resolves when inspectpoint_id arrives as a STRING, the way node-postgres really returns a bigint column", async () => {
  reset();
  seed();
  // The fixtures above seed inspectpoint_id as a NUMBER, which is why this bug
  // survived: node-postgres returns a bigint column as a JS string, while the
  // contact payload's buildings[].id is a JSON number. Keying the
  // primary-contact map on one and looking it up with the other silently
  // matched nothing, so locations.primary_contact_id — and every job's, which
  // mirrors it — was null for an entire real tenant (797/797 buildings).
  rawRows.inspectpoint_locations = [
    { inspectpoint_id: "10", inspectpoint_customer_id: "1", payload: { name: "Building A", account_id: 1 } },
    { inspectpoint_id: "11", inspectpoint_customer_id: "1", payload: { name: "Building B", account_id: 1 } },
  ];
  await provider.normalizeAll(9);
  const locationRows = upsertFor("locations").argsList;
  assert.equal(locationRows.find((l) => l.externalRef === "10").primaryContactId, 601);
  assert.equal(locationRows.find((l) => l.externalRef === "11").primaryContactId, 602);
});
