/**
 * Junction tables must forget links, not only learn them.
 *
 * Found on a real account: a contact unlinked from a location in ServiceTrade
 * stayed attached in `contact_locations` and would still have been sent that
 * location's confirmations. The raw table was correct the whole time — the
 * normalized junction was stale, because every junction was written with
 * `INSERT … ON CONFLICT DO NOTHING` and nothing anywhere issued a DELETE. Ten
 * junctions shared that helper, including `appointment_technicians`, which feeds
 * the technician names both agents read out to customers.
 *
 * Not a webhook bug — the hourly poll behaved identically. Webhooks only shrank
 * the time-to-notice from an hour to a minute.
 *
 * The dangerous half of the fix is the DELETE, so most of these tests are about
 * what must NOT be deleted:
 *
 *   - parents this pass never looked at (the appointment passes are
 *     watermark-filtered, so "delete everything not in pairs" would wipe live
 *     links for every unchanged appointment)
 *   - contacts whose raw payload never asserted any links at all (a thin
 *     ServiceTrade embed carries no `locations` key, and payload is REPLACED
 *     wholesale on upsert, so treating absence as emptiness destroys real data)
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);

// A db stub that models the junction tables as real sets, so a DELETE's effect
// is observable rather than asserted against SQL text.
const tables = new Map();          // table -> Set("a|b")
const statements = [];

function tableOf(name) {
  if (!tables.has(name)) tables.set(name, new Set());
  return tables.get(name);
}

function runDelete(sql, params) {
  const table = sql.match(/DELETE FROM (\w+)/)[1];
  const [parents, flatA, flatB] = params;
  const keep = new Set(flatA.map((a, i) => `${a}|${flatB[i]}`));
  const set = tableOf(table);
  let removed = 0;
  for (const row of [...set]) {
    const [a] = row.split("|");
    // Mirrors the SQL: scoped to the listed parents, keeping any pair present
    // in the new set.
    if (parents.map(String).includes(a) && !keep.has(row)) { set.delete(row); removed++; }
  }
  return { rows: [], rowCount: removed };
}

function runInsert(sql, params) {
  const table = sql.match(/INSERT INTO (\w+)/)[1];
  const set = tableOf(table);
  for (let i = 0; i < params.length; i += 2) set.add(`${params[i]}|${params[i + 1]}`);
  return { rows: [], rowCount: 0 };
}

const rawRows = { servicetrade_contacts: [], servicetrade_appointments: [], servicetrade_locations: [], servicetrade_jobs: [] };
const refMaps = {};

stub("db", {
  query: async (sql, params) => {
    statements.push({ sql, params });
    if (/^\s*DELETE FROM/.test(sql)) {
      const r = runDelete(sql, params);
      statements[statements.length - 1].removed = r.rowCount;   // observable, for assertions
      return r;
    }
    if (/^\s*INSERT INTO/.test(sql)) return runInsert(sql, params);
    return { rows: [], rowCount: 0 };
  },
  fetchAllByCompanyChunked: async (_companyId, table) => rawRows[table] || [],
  fetchExternalRefMap: async (_companyId, table) => refMaps[table] || new Map(),
  bulkUpsertByExternalRef: async () => 0,
  fetchAllByCompany: async () => [],
});
stub("db/service-line-descriptions", { listByCompany: async () => [] });
stub("db/servicetrade-sync", {});
stub("db/servicetrade-credentials", { getByCompanyId: async () => null });
stub("services/servicetrade-sync", { runSync: async () => ({ success: true }) });
stub("services/job-confirmation-status", { syncAllJobStatuses: async () => {} });

const provider = require("../src/services/crm/servicetrade/provider");

function reset() {
  tables.clear();
  statements.length = 0;
  for (const k of Object.keys(rawRows)) rawRows[k] = [];
  for (const k of Object.keys(refMaps)) delete refMaps[k];
  logger.reset();
}

const map = (pairs) => new Map(pairs.map(([k, v]) => [String(k), v]));

// ── The reported bug ────────────────────────────────────────────────────────

test("a contact unlinked from one of several locations loses exactly that row", async () => {
  reset();
  tableOf("contact_locations").add("51156|121260");   // the stale link
  tableOf("contact_locations").add("51156|999");      // a link that survives
  rawRows.servicetrade_contacts = [
    { servicetrade_id: "2657733956302913", email: "pavan@x.test", payload: { locations: [{ id: "888" }] } },
  ];
  refMaps.contacts = map([["2657733956302913", 51156]]);
  refMaps.locations = map([["888", 999], ["777", 121260]]);
  refMaps.customers = new Map();

  await provider._normalizeContactJunctions(8);

  assert.deepEqual([...tableOf("contact_locations")], ["51156|999"],
    "the removed location must be gone and the remaining one untouched");
});

test("a technician unassigned from an appointment stops being linked", async () => {
  // This one is customer-facing: both agents read these names out loud.
  reset();
  tableOf("appointment_technicians").add("501|900");   // unassigned in the CRM
  tableOf("appointment_technicians").add("501|901");   // still assigned
  const rawAppointments = [{ servicetrade_id: "A1", payload: { techs: [{ id: "T901" }] } }];
  refMaps.appointments = map([["A1", 501]]);
  refMaps.technicians = map([["T901", 901], ["T900", 900]]);

  await provider._normalizeAppointmentTechnicians(8, rawAppointments);

  assert.deepEqual([...tableOf("appointment_technicians")], ["501|901"]);
});

test("an appointment whose last technician was removed ends up with none", async () => {
  reset();
  tableOf("appointment_technicians").add("501|900");
  const rawAppointments = [{ servicetrade_id: "A1", payload: { techs: [] } }];
  refMaps.appointments = map([["A1", 501]]);
  refMaps.technicians = map([["T900", 900]]);

  await provider._normalizeAppointmentTechnicians(8, rawAppointments);

  assert.equal(tableOf("appointment_technicians").size, 0,
    "zero pairs for a processed parent is a real state, not a reason to skip the delete");
});

// ── What must NOT be deleted ────────────────────────────────────────────────

test("parents outside this pass keep their links — the passes are watermark-filtered", async () => {
  reset();
  tableOf("appointment_technicians").add("501|900");   // appointment IN this pass, unassigned
  tableOf("appointment_technicians").add("777|900");   // appointment NOT in this pass
  const rawAppointments = [{ servicetrade_id: "A1", payload: { techs: [] } }];
  refMaps.appointments = map([["A1", 501]]);
  refMaps.technicians = map([["T900", 900]]);

  await provider._normalizeAppointmentTechnicians(8, rawAppointments);

  assert.deepEqual([...tableOf("appointment_technicians")], ["777|900"],
    "an incremental normalize sees only changed appointments; deleting beyond them wipes live data");
});

test("a contact whose payload asserts nothing is left completely alone", async () => {
  // servicetrade_contacts.payload is the raw object verbatim and is REPLACED
  // wholesale on upsert. A thin embed (location.primaryContact) carries no
  // `locations` key, so absence means "we were not told", not "there are none".
  reset();
  tableOf("contact_locations").add("51156|121260");
  tableOf("contact_companies").add("51156|87540");
  rawRows.servicetrade_contacts = [
    { servicetrade_id: "2657733956302913", email: "pavan@x.test", payload: { id: "2657733956302913", firstName: "Pavan" } },
  ];
  refMaps.contacts = map([["2657733956302913", 51156]]);
  refMaps.locations = new Map();
  refMaps.customers = new Map();

  await provider._normalizeContactJunctions(8);

  assert.deepEqual([...tableOf("contact_locations")], ["51156|121260"],
    "treating an uninformative payload as empty would delete every real link this contact has");
  assert.deepEqual([...tableOf("contact_companies")], ["51156|87540"]);
});

test("locations and companies are scoped independently", async () => {
  // A payload can carry one and not the other; asserting locations must not
  // license deleting company links.
  reset();
  tableOf("contact_locations").add("51156|121260");
  tableOf("contact_companies").add("51156|87540");
  rawRows.servicetrade_contacts = [
    { servicetrade_id: "C1", email: "a@x.test", payload: { locations: [{ id: "L2" }] } },
  ];
  refMaps.contacts = map([["C1", 51156]]);
  refMaps.locations = map([["L2", 555]]);
  refMaps.customers = new Map();

  await provider._normalizeContactJunctions(8);

  assert.deepEqual([...tableOf("contact_locations")], ["51156|555"], "locations were asserted, so they replace");
  assert.deepEqual([...tableOf("contact_companies")], ["51156|87540"], "companies were not asserted, so they stand");
});

test("an empty pass issues no DELETE at all", async () => {
  reset();
  tableOf("contact_locations").add("51156|121260");
  rawRows.servicetrade_contacts = [];
  refMaps.contacts = new Map();

  await provider._normalizeContactJunctions(8);

  assert.equal(statements.filter((s) => /DELETE FROM/.test(s.sql)).length, 0,
    "a normalize that read nothing must not be able to delete anything");
  assert.deepEqual([...tableOf("contact_locations")], ["51156|121260"]);
});

test("a contact that resolves to no platform row is not a parent", async () => {
  reset();
  tableOf("contact_locations").add("51156|121260");
  rawRows.servicetrade_contacts = [
    { servicetrade_id: "UNKNOWN", email: "z@x.test", payload: { locations: [{ id: "L1" }] } },
  ];
  refMaps.contacts = new Map();       // nothing resolves
  refMaps.locations = map([["L1", 121260]]);
  refMaps.customers = new Map();

  await provider._normalizeContactJunctions(8);
  assert.deepEqual([...tableOf("contact_locations")], ["51156|121260"]);
});

// ── The delete is scoped in SQL, not just in JS ─────────────────────────────

test("the DELETE is bounded by an explicit parent list", async () => {
  reset();
  const rawAppointments = [{ servicetrade_id: "A1", payload: { techs: [{ id: "T1" }] } }];
  refMaps.appointments = map([["A1", 501]]);
  refMaps.technicians = map([["T1", 900]]);

  await provider._normalizeAppointmentTechnicians(8, rawAppointments);

  const del = statements.find((s) => /DELETE FROM appointment_technicians/.test(s.sql));
  assert.ok(del, "a replace-set write must actually issue a DELETE");
  assert.match(del.sql, /appointment_id = ANY\(\$1::bigint\[\]\)/,
    "an unscoped DELETE would empty the table for every company");
  assert.deepEqual(del.params[0], [501]);
});

test("the delete runs before the insert, so a surviving pair is never dropped", async () => {
  reset();
  tableOf("appointment_technicians").add("501|900");
  const rawAppointments = [{ servicetrade_id: "A1", payload: { techs: [{ id: "T900" }, { id: "T901" }] } }];
  refMaps.appointments = map([["A1", 501]]);
  refMaps.technicians = map([["T900", 900], ["T901", 901]]);

  await provider._normalizeAppointmentTechnicians(8, rawAppointments);

  const order = statements.filter((s) => /DELETE FROM|INSERT INTO/.test(s.sql))
    .map((s) => (/DELETE/.test(s.sql) ? "delete" : "insert"));
  assert.deepEqual(order, ["delete", "insert"]);
  assert.deepEqual([...tableOf("appointment_technicians")].sort(), ["501|900", "501|901"]);
});

test("re-running an unchanged pass is a no-op", async () => {
  reset();
  const rawAppointments = [{ servicetrade_id: "A1", payload: { techs: [{ id: "T1" }] } }];
  refMaps.appointments = map([["A1", 501]]);
  refMaps.technicians = map([["T1", 900]]);

  await provider._normalizeAppointmentTechnicians(8, rawAppointments);
  const after = [...tableOf("appointment_technicians")];
  statements.length = 0;
  await provider._normalizeAppointmentTechnicians(8, rawAppointments);

  assert.deepEqual([...tableOf("appointment_technicians")], after, "idempotent");
  const del = statements.find((s) => /DELETE FROM/.test(s.sql));
  assert.equal(del.removed, 0,
    "a steady state must delete nothing — otherwise every sync churns rows and the log cries wolf");
});

// ── The other junctions got the same treatment ─────────────────────────────

test("job and location junctions also replace rather than accumulate", async () => {
  reset();
  tableOf("job_tags").add("33187|1");
  rawRows.servicetrade_jobs = [{ servicetrade_id: "J1", payload: { tags: [{ id: "TAG2" }] } }];
  refMaps.jobs = map([["J1", 33187]]);
  refMaps.tags = map([["TAG2", 2], ["TAG1", 1]]);
  await provider._normalizeJobTags(8);
  assert.deepEqual([...tableOf("job_tags")], ["33187|2"]);

  reset();
  tableOf("location_offices").add("121260|7");
  rawRows.servicetrade_locations = [{ servicetrade_id: "L1", payload: { offices: [] } }];
  refMaps.locations = map([["L1", 121260]]);
  refMaps.offices = map([["O7", 7]]);
  await provider._normalizeLocationOffices(8);
  assert.equal(tableOf("location_offices").size, 0);
});
