/**
 * crm/zentrades/provider.js — normalizeAll's orchestration: FK resolution
 * order, contact dedupe -> location primary contact -> job primary contact
 * propagation, and the field descriptors actually written for
 * bulkUpsertByExternalRef. Fake db throughout, matching the exact
 * convention test/inspectpoint-provider-normalize.test.js established for
 * this kind of test — no junction-table spying needed here (ZenTrades has
 * none: no offices/tags, and assignment:appointment is 1:1 so there's
 * exactly one technician per appointment already).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const upsertCalls = [];
let rawRows = {};
let refMaps = {};
let locationRowsForJobPass = [];

stub("db", {
  query: async (sql) => {
    if (/SELECT id, primary_contact_id FROM locations/.test(sql)) return { rows: locationRowsForJobPass };
    return { rows: [] };
  },
  fetchAllByCompanyChunked: async (_companyId, table) => rawRows[table] || [],
  fetchExternalRefMap: async (_companyId, table, source) => {
    assert.equal(source, "zentrades", `fetchExternalRefMap for ${table} must be scoped to source='zentrades'`);
    return refMaps[table] || new Map();
  },
  bulkUpsertByExternalRef: async (table, fields, argsList) => {
    upsertCalls.push({ table, fields, argsList });
    return argsList.length;
  },
});

const provider = require("../src/services/crm/zentrades/provider");

function reset() {
  upsertCalls.length = 0;
  rawRows = {};
  refMaps = {};
  locationRowsForJobPass = [];
}

function upsertFor(table) {
  return upsertCalls.find((c) => c.table === table);
}

/** One ticket, its customer, its service address, one live assignment + technician. */
function seedBasicTicket() {
  rawRows.zentrades_customers = [{ zentrades_id: 368, is_active: true, payload: { displayName: "Nov Com12", email: "sandeep@smartserv.io" } }];
  rawRows.zentrades_locations = [{ zentrades_id: 418, zentrades_customer_id: 368, do_not_serve: false, is_active: true, payload: { displayName: "Nov Com12" } }];
  rawRows.zentrades_contacts = [
    { zentrades_id: "addr:418", contact_kind: "service_address", zentrades_customer_id: 368, zentrades_location_id: 418, email_lower: "sandeep@smartserv.io", is_active: true, payload: { email: "sandeep@smartserv.io", firstname: "Sandeep" } },
    { zentrades_id: "cust:368", contact_kind: "customer", zentrades_customer_id: 368, zentrades_location_id: null, email_lower: "sandeep@smartserv.io", is_active: true, payload: { email: "sandeep@smartserv.io" } },
  ];
  rawRows.zentrades_technicians = [{ zentrades_id: 4705, is_active: true, payload: { firstName: "1Ank", lastName: "ww", email: "ank@x.test" } }];
  // scheduled_start/end are real Date objects here, deliberately — that is
  // what node-postgres actually returns for a TIMESTAMPTZ column, and a
  // fixture using plain strings would not have caught the live bug where
  // normalizeJob's scheduledDate broke specifically on a Date object
  // (String(dateObject).slice(0,10) reads Date.prototype.toString(), not
  // toISOString()).
  rawRows.zentrades_tickets = [{
    zentrades_id: 1924543, zentrades_customer_id: 368, zentrades_location_id: 418, job_status_id: 1,
    ticket_number: "009670", scheduled_start: new Date("2026-09-14T13:15:00.000Z"), scheduled_end: new Date("2026-09-14T15:15:00.000Z"),
    combined_feature_flag: null, is_active: true,
    payload: {
      jobDescription: "Test", jobType: "AC Repair", isActive: true, isDeleted: false,
      assignments: [{ id: 2790843, technicianId: 4705, startTime: "2026-09-14T13:15:00.000Z", isActive: true, isDeleted: false }],
    },
  }];
  rawRows.zentrades_appointments = [{
    zentrades_id: 2790843, zentrades_ticket_id: 1924543, zentrades_technician_id: 4705,
    assignment_status: "Open", assignment_status_cf: "Open: return trip needed", recurring_assignment_id: 1788786528,
    scheduled_start: new Date("2026-09-14T13:15:00.000Z"), scheduled_end: new Date("2026-09-14T15:15:00.000Z"),
    payload: { isActive: true, isDeleted: false },
  }];

  // Reference maps as they'd exist AFTER each earlier pass upserted its rows —
  // the provider re-fetches these between passes, so tests populate them to
  // simulate "the previous pass already ran".
  refMaps.customers = new Map([["368", 501]]);
  refMaps.contacts = new Map([["addr:418", 601]]); // only the canonical (service_address) survives dedupe
  refMaps.locations = new Map([["418", 701]]);
  refMaps.technicians = new Map([["4705", 801]]);
  refMaps.jobs = new Map([["1924543", 901]]);
  locationRowsForJobPass = [{ id: 701, primary_contact_id: 601 }];
}

test("normalizeAll runs passes in FK-safe order and returns per-entity counts", async () => {
  reset();
  seedBasicTicket();
  const counts = await provider.normalizeAll(11, null);
  assert.deepEqual(counts, { customers: 1, contacts: 1, technicians: 1, locations: 1, jobs: 1, appointments: 1 });
});

test("contact dedupe collapses the customer+service_address duplicate into ONE upserted contact row", async () => {
  reset();
  seedBasicTicket();
  await provider.normalizeAll(11, null);
  const contactsArgs = upsertFor("contacts").argsList;
  assert.equal(contactsArgs.length, 1);
  assert.equal(contactsArgs[0].externalRef, "addr:418", "service_address wins canonical per kind priority");
});

test("the location's primary_contact_id resolves through the dedupe alias to the canonical contact's PLATFORM id", async () => {
  reset();
  seedBasicTicket();
  await provider.normalizeAll(11, null);
  const locationsArgs = upsertFor("locations").argsList;
  assert.equal(locationsArgs[0].primaryContactId, 601, "resolved via refMaps.contacts['addr:418'] -> 601");
  assert.equal(locationsArgs[0].customerId, 501);
});

test("a job's primary_contact_id MIRRORS its location's, read back from the already-normalized locations row", async () => {
  reset();
  seedBasicTicket();
  await provider.normalizeAll(11, null);
  const jobsArgs = upsertFor("jobs").argsList;
  assert.equal(jobsArgs[0].primaryContactId, 601, "same value locationRowsForJobPass reported for location 701");
  assert.equal(jobsArgs[0].locationId, 701);
  assert.equal(jobsArgs[0].customerId, 501);
});

test("REGRESSION: a job's scheduled_date is a valid DATE-column string even when the raw row's scheduled_start is a real Date object (what pg actually returns)", async () => {
  reset();
  seedBasicTicket();
  await provider.normalizeAll(11, null);
  const jobsArgs = upsertFor("jobs").argsList;
  assert.equal(jobsArgs[0].scheduledDate, "2026-09-14");
});

test("a job's technicianId is the earliest LIVE assignment's technician, resolved to the platform id", async () => {
  reset();
  seedBasicTicket();
  await provider.normalizeAll(11, null);
  const jobsArgs = upsertFor("jobs").argsList;
  assert.equal(jobsArgs[0].technicianId, 801);
});

test("an appointment resolves jobId/technicianId via the tickets/technicians ref maps", async () => {
  reset();
  seedBasicTicket();
  await provider.normalizeAll(11, null);
  const apptArgs = upsertFor("appointments").argsList;
  assert.equal(apptArgs[0].jobId, 901);
  assert.equal(apptArgs[0].technicianId, 801);
  assert.equal(new Date(apptArgs[0].scheduledStart).toISOString(), "2026-09-14T13:15:00.000Z");
  assert.equal(new Date(apptArgs[0].scheduledEnd).toISOString(), "2026-09-14T15:15:00.000Z");
});

test("the appointment status field descriptor guards against clobbering an agent-made confirmation on re-sync", async () => {
  reset();
  seedBasicTicket();
  await provider.normalizeAll(11, null);
  const apptFields = upsertFor("appointments").fields;
  const statusField = apptFields.find((f) => f.column === "status");
  assert.match(statusField.updateExpr, /CASE WHEN appointments\.status IN \('confirmed','rescheduled','cancelled'\)/);
});

test("every fetchExternalRefMap call is scoped to source='zentrades' (asserted inside the stub itself)", async () => {
  reset();
  seedBasicTicket();
  await provider.normalizeAll(11, null); // throws via the stub's own assertion if any call omits/misspells the source
});

test("a ticket with no resolvable customer/location still normalizes as a job — never skipped for missing FKs", async () => {
  reset();
  rawRows.zentrades_tickets = [{
    zentrades_id: 42, zentrades_customer_id: null, zentrades_location_id: null, job_status_id: 1,
    ticket_number: "000042", scheduled_start: null, scheduled_end: null, combined_feature_flag: null, is_active: true,
    payload: { assignments: [] },
  }];
  const counts = await provider.normalizeAll(11, null);
  assert.equal(counts.jobs, 1);
  const jobsArgs = upsertFor("jobs").argsList;
  assert.equal(jobsArgs[0].customerId, null);
  assert.equal(jobsArgs[0].locationId, null);
  assert.equal(jobsArgs[0].status, "open");
});

test("emit fires 'entity_done' for every pass when an engine is provided", async () => {
  reset();
  seedBasicTicket();
  const emitted = [];
  const engine = { emit: async (type, payload) => emitted.push(payload.entity) };
  await provider.normalizeAll(11, engine);
  assert.deepEqual(emitted, ["customers", "contacts", "technicians", "locations", "jobs", "appointments"]);
});
