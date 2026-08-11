/**
 * `call_settings.confirmation_contact_types` — storage and canonicalisation.
 *
 * Matching is an exact comparison against `lower(btrim(type))` on the contact
 * side, so anything stored with a stray capital or trailing space silently
 * matches nobody — a setting that looks configured in the UI and quietly does
 * nothing. Normalisation therefore lives in the db layer rather than the route,
 * because the copilot's update-call-settings tool calls upsert() directly and
 * would otherwise bypass it. These tests pin that.
 *
 * Runs against a fake db — no database.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub } = require("./helpers/stub-modules");

const db = createFakeDb();
stub("db", db);

const callSettingsDb = require("../src/db/call-settings");

const CO = 7;

/** Capture what upsert would actually write for the given field values. */
async function writtenValue(fields) {
  db.reset();
  db.on("INSERT INTO call_settings", [{}]);
  await callSettingsDb.upsert(CO, fields);
  const call = db.calls.find((c) => c.sql.includes("INSERT INTO call_settings"));
  if (!call) return { keys: [], params: [] };
  // params[0] is companyId; the rest line up with the INSERT column order.
  const keys = call.sql.match(/INSERT INTO call_settings \(company_id, ([^)]*)\)/)[1]
    .split(",").map((s) => s.trim());
  return { keys, params: call.params.slice(1), sql: call.sql };
}

// ── defaults / read path ─────────────────────────────────────────────────────

test("defaults to an empty list, so no company is opted in by the migration", () => {
  assert.deepEqual(callSettingsDb.DEFAULTS.confirmation_contact_types, []);
});

test("a company with no settings row reads as [] rather than undefined", async () => {
  db.reset();
  db.on("SELECT", []); // no row
  const s = await callSettingsDb.getByCompanyId(CO);
  assert.deepEqual(s.confirmation_contact_types, []);
});

test("a NULL column reads as [] — callers do .length on it", async () => {
  db.reset();
  db.on("FROM call_settings", [{ confirmation_contact_types: null }]);
  const s = await callSettingsDb.getByCompanyId(CO);
  assert.deepEqual(s.confirmation_contact_types, []);
});

test("the column is actually selected, or GET would never return it", async () => {
  db.reset();
  db.on("FROM call_settings", [{}]);
  await callSettingsDb.getByCompanyId(CO);
  assert.match(db.sqls()[0], /confirmation_contact_types/);
});

// ── write path: canonicalisation ─────────────────────────────────────────────

test("values are lower-cased, trimmed and de-duplicated on write", async () => {
  const { keys, params } = await writtenValue({
    confirmation_contact_types: ["  On-Site  ", "SCHEDULING", "on-site", "Property Manager"],
  });
  const v = params[keys.indexOf("confirmation_contact_types")];
  assert.deepEqual(v, ["on-site", "scheduling", "property manager"]);
});

test("dedupe is case/whitespace aware, not identity-based", async () => {
  const { keys, params } = await writtenValue({
    confirmation_contact_types: ["on-site", "On-Site", "ON-SITE ", " on-site"],
  });
  assert.deepEqual(params[keys.indexOf("confirmation_contact_types")], ["on-site"]);
});

test("non-string and empty entries are dropped rather than stored", async () => {
  const { keys, params } = await writtenValue({
    confirmation_contact_types: ["on-site", "", "   ", null, undefined, 42, {}, "scheduling"],
  });
  assert.deepEqual(params[keys.indexOf("confirmation_contact_types")], ["on-site", "scheduling"]);
});

test("an empty array is preserved — that is how the feature is switched off", async () => {
  const { keys, params } = await writtenValue({ confirmation_contact_types: [] });
  assert.deepEqual(params[keys.indexOf("confirmation_contact_types")], []);
});

test("the array is passed through as a JS array, not JSON-stringified", async () => {
  const { keys, params } = await writtenValue({ confirmation_contact_types: ["on-site"] });
  const v = params[keys.indexOf("confirmation_contact_types")];
  assert.ok(Array.isArray(v), "the column is TEXT[]; a JSON string would be stored as one literal element");
  assert.notEqual(typeof v, "string");
});

test("other settings are untouched by the normaliser", async () => {
  const { keys, params } = await writtenValue({
    confirmation_contact_types: ["On-Site"],
    business_hours_start: "09:00",
    max_attempts: 3,
    crm_comment_writeback_enabled: true,
  });
  assert.equal(params[keys.indexOf("business_hours_start")], "09:00");
  assert.equal(params[keys.indexOf("max_attempts")], 3);
  assert.equal(params[keys.indexOf("crm_comment_writeback_enabled")], true);
});

test("the field is on the write allow-list (otherwise the UI would silently no-op)", async () => {
  const { keys } = await writtenValue({ confirmation_contact_types: ["on-site"] });
  assert.ok(keys.includes("confirmation_contact_types"));
});

test("unknown fields are still rejected by the allow-list", async () => {
  db.reset();
  db.on("SELECT", [{}]);
  await callSettingsDb.upsert(CO, { totally_made_up_column: true });
  assert.equal(db.matched("INSERT INTO call_settings").length, 0);
});
