/**
 * services/csv-import/entities.js — import rows -> the five platform entity
 * payloads, and the field descriptors they're written with.
 *
 * The descriptor assertions are the important half of this file. CSV is the
 * only source with no write-back mirror, which means a re-uploaded export is
 * stale by construction and must not be allowed to overwrite state the agent
 * or a human established. Two of those guards are the difference between the
 * feature working and actively causing harm:
 *
 *   - jobs.status must land 'scheduled', because the confirmation sweep
 *     matches `status IN ('scheduled','rescheduled')` — an 'open' job imports
 *     cleanly and is then never called.
 *   - appointments.scheduled_start must not move a visit the customer already
 *     confirmed, or last night's export silently undoes this afternoon's call.
 */

process.env.TZ = "Asia/Kolkata";

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [] }) });

const e = require("../src/services/csv-import/entities");

const TZ = "America/New_York";
const CTX = { companyId: 7, timezone: TZ };

function row(over = {}) {
  return {
    rowNumber: 2,
    reference: "WO-1",
    jobReference: "WO-1",
    customerName: "Acme Inc",
    phone: "+15551234567",
    email: null,
    scheduledStart: "2026-03-04T19:00:00.000Z",
    scheduledEnd: null,
    serviceDescription: "Annual inspection",
    technicianName: null,
    contactName: null,
    address: { addressLine1: null, city: null, state: null, zipcode: null },
    extra: {},
    ...over,
  };
}

// ── The two guards that matter most ─────────────────────────────────────────

test("jobs.status lands 'scheduled', NOT 'open' — an 'open' job is never picked up by the confirmation sweep", () => {
  const built = e.buildEntities([row()], CTX);
  assert.equal(built.jobs[0].status, "scheduled");

  const desc = e.JOB_FIELDS.find((f) => f.column === "status");
  assert.equal(desc.transform(undefined), "scheduled", "the default must be 'scheduled', not InspectPoint's 'open'");
});

test("a re-import cannot drag a job back out of confirmed/cancelled/completed", () => {
  const expr = e.JOB_FIELDS.find((f) => f.column === "status").updateExpr;
  for (const protectedStatus of ["confirmed", "cancelled", "completed", "in_progress"]) {
    assert.match(expr, new RegExp(`'${protectedStatus}'`), `${protectedStatus} must be protected on re-import`);
  }
  assert.match(expr, /jobs\.status/, "the guard must read the EXISTING row, not EXCLUDED");
});

test("a re-import cannot move a visit whose time the customer already agreed to", () => {
  for (const column of ["scheduled_start", "scheduled_end"]) {
    const desc = e.APPOINTMENT_FIELDS.find((f) => f.column === column);
    assert.ok(desc.updateExpr, `${column} must be guarded — CSV has no write-back, so an export is stale by construction`);
    assert.match(desc.updateExpr, /appointments\.status IN \('confirmed','rescheduled'\)/);
    assert.match(desc.updateExpr, new RegExp(`appointments\\.${column}`), "must keep the existing value, not take EXCLUDED");
  }
});

test("appointment status keeps the agent's own confirmations across a re-import", () => {
  const expr = e.APPOINTMENT_FIELDS.find((f) => f.column === "status").updateExpr;
  assert.match(expr, /appointments\.status IN \('confirmed','rescheduled','cancelled'\)/);
});

test("no descriptor writes a column the importer has no business setting", () => {
  const all = [...e.CUSTOMER_FIELDS, ...e.LOCATION_FIELDS, ...e.CONTACT_FIELDS, ...e.JOB_FIELDS, ...e.APPOINTMENT_FIELDS].map((f) => f.column);
  for (const forbidden of ["customer_confirmed", "customer_confirmed_at", "created_at", "id", "company_id", "external_ref", "source"]) {
    assert.equal(all.includes(forbidden), false, `${forbidden} must never be in a field descriptor`);
  }
});

// ── Entity shaping ──────────────────────────────────────────────────────────

test("repeated rows for one customer produce ONE customer, and blanks are filled from later rows rather than overwriting", () => {
  const built = e.buildEntities([
    row({ reference: "WO-1", address: { addressLine1: "1 Main St", city: "Boston", state: "MA", zipcode: "02101" } }),
    row({ reference: "WO-2", address: { addressLine1: null, city: null, state: null, zipcode: null } }),
  ], CTX);
  assert.equal(built.customers.length, 1);
  assert.equal(built.customers[0].addressLine1, "1 Main St", "a later blank must not erase an earlier value");
  assert.equal(built.appointments.length, 2);
});

test("several visits sharing a job reference collapse to one job with several appointments", () => {
  const built = e.buildEntities([
    row({ reference: "WO-1", jobReference: "J-500" }),
    row({ reference: "WO-2", jobReference: "J-500" }),
  ], CTX);
  assert.equal(built.jobs.length, 1);
  assert.equal(built.jobs[0].externalRef, "J-500");
  assert.deepEqual(built.appointments.map((a) => a.externalRef), ["WO-1", "WO-2"]);
  assert.ok(built.appointments.every((a) => a.jobRef === "J-500"));
});

test("the appointment's external_ref is the row's own reference, verbatim — that's the upsert key", () => {
  const built = e.buildEntities([row({ reference: "WO-1001" })], CTX);
  assert.equal(built.appointments[0].externalRef, "WO-1001");
  assert.equal(built.appointments[0].source, "csv");
});

test("derived refs are version-prefixed and stable across runs, but differ for different inputs", () => {
  const a = e.buildEntities([row()], CTX).customers[0].externalRef;
  const b = e.buildEntities([row()], CTX).customers[0].externalRef;
  const c = e.buildEntities([row({ customerName: "Beta LLC" })], CTX).customers[0].externalRef;
  assert.equal(a, b, "the same input must always produce the same ref, or a re-import duplicates everything");
  assert.notEqual(a, c);
  assert.match(a, /^csvv1:cust:[0-9a-f]{16}$/);
});

test("a location is only created when the file carries an address — never invented from the customer name", () => {
  assert.equal(e.buildEntities([row()], CTX).locations.length, 0);
  const withAddr = e.buildEntities([row({ address: { addressLine1: "1 Main St", city: "Boston", state: "MA", zipcode: "02101" } })], CTX);
  assert.equal(withAddr.locations.length, 1);
  assert.equal(withAddr.jobs[0].locationRef, withAddr.locations[0].externalRef);
});

test("a contact is only created when a person is named — the customer's own phone lives on the customer", () => {
  assert.equal(e.buildEntities([row()], CTX).contacts.length, 0);
  const withContact = e.buildEntities([row({ contactName: "Jane Smith" })], CTX);
  assert.equal(withContact.contacts.length, 1);
  assert.equal(withContact.contacts[0].firstName, "Jane");
  assert.equal(withContact.contacts[0].lastName, "Smith");
});

test("unknown CSV columns ride along on the appointment so the agent can still answer questions about them", () => {
  const built = e.buildEntities([row({ extra: { "Gate Code": "#4455" } })], CTX);
  assert.deepEqual(built.appointments[0].additionalInformation.csv_columns, { "Gate Code": "#4455" });
});

test("jobs.scheduled_date is the LOCAL calendar day, not a UTC truncation", () => {
  // 00:30Z on 5 March is still the evening of 4 March in New York. A UTC
  // truncation would file this job under the wrong day.
  const built = e.buildEntities([row({ scheduledStart: "2026-03-05T00:30:00.000Z" })], CTX);
  assert.equal(built.jobs[0].scheduledDate, "2026-03-04");
});

test("duration is derived in SECONDS from the start/end pair, matching the column's convention", () => {
  const built = e.buildEntities([row({ scheduledStart: "2026-03-04T19:00:00.000Z", scheduledEnd: "2026-03-04T21:00:00.000Z" })], CTX);
  assert.equal(built.appointments[0].duration, 7200);
  assert.equal(e.buildEntities([row()], CTX).appointments[0].duration, null);
});

test("splitName handles the 'Last, First' form and single names", () => {
  assert.deepEqual(e.splitName("Jane Smith"), { firstName: "Jane", lastName: "Smith" });
  assert.deepEqual(e.splitName("Smith, Jane"), { firstName: "Jane", lastName: "Smith" });
  assert.deepEqual(e.splitName("Cher"), { firstName: "Cher", lastName: null });
  assert.deepEqual(e.splitName(""), { firstName: null, lastName: null });
});
