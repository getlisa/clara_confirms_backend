/**
 * InspectPoint deficiencies reaching the confirmation agent (CMAP-228).
 *
 * The property this file exists to protect: deficiencies travel as
 * `appointment_services` rows so they reuse the existing service path, but they
 * must NEVER leak into the `service_*` fields. Those describe what the visit IS,
 * and `service_summary` feeds the agent's OPENING LINE — an unflagged repair
 * makes Kelly announce unscheduled work as booked.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const normalize = require("../src/services/crm/inspectpoint/normalize");

// ── the spoken label ─────────────────────────────────────────────────────────

test("a checklist question loses its question mark, so nothing reads as a question", () => {
  // 231 of 436 open rows in the live tenant end in "?" — read aloud verbatim
  // the agent interrogates the customer instead of reporting a fault.
  assert.equal(normalize.cleanDeficiencyLabel({ display_name: "Is wiring waterproof?" }), "Is wiring waterproof");
  assert.equal(normalize.cleanDeficiencyLabel({ display_name: "Are the covers in place?  " }), "Are the covers in place");
});

test("the label is NOT negated — inventing the fault would be a guess", () => {
  // No deterministic rule turns "Is wiring waterproof?" into "wiring is not
  // waterproof" reliably. On a compliance topic that guess is worse than the
  // clumsy phrasing, so the prompt is told these are FAILED checks instead.
  const out = normalize.cleanDeficiencyLabel({ display_name: "Is wiring waterproof?" });
  assert.ok(!/not|fail|missing/i.test(out), "no invented negation");
});

test("a row is never nameless — notes, then asset type, then a generic", () => {
  assert.equal(normalize.cleanDeficiencyLabel({ display_name: "", notes: "No microswitch present" }), "No microswitch present");
  assert.equal(
    normalize.cleanDeficiencyLabel({ display_name: null, payload: { asset_details: { "Equipment type": "Hood Cleaning" } } }),
    "Unspecified hood cleaning item"
  );
  assert.equal(normalize.cleanDeficiencyLabel({ display_name: null }), "Unspecified item");
});

test("a multi-line note is reduced to its first line and capped", () => {
  const long = "First line of the note\nsecond line\nthird";
  assert.equal(normalize.cleanDeficiencyLabel({ display_name: "", notes: long }), "First line of the note");
});

// ── normalization ────────────────────────────────────────────────────────────

const rawRow = (o = {}) => ({
  inspectpoint_id: 1000,
  inspectpoint_location_id: 581,
  inspectpoint_inspection_id: 1068,
  display_name: "Is wiring waterproof?",
  notes: null,
  deficiency_status: null,
  resolution_status: "New",
  is_resolved: false,
  date_opened: "2026-09-29T11:22:33.271-04:00",
  date_resolved: null,
  reference_number: null,
  unique_id: "FE0EB681",
  payload: { asset_details: { "System/Asset Type": "Equipment", "Equipment type": "Hood Cleaning" } },
  ...o,
});

test("normalizeDeficiency carries the location and keeps the InspectPoint id", () => {
  const out = normalize.normalizeDeficiency(rawRow(), { companyId: 11, locationId: 42 });
  assert.equal(out.locationId, 42);
  assert.equal(out.externalRef, "1000");
  assert.equal(out.source, "inspectpoint");
  assert.equal(out.name, "Is wiring waterproof");
  assert.equal(out.isResolved, false);
  assert.equal(out.additionalInformation.inspectpoint_deficiency_id, "1000");
  assert.equal(out.additionalInformation.asset_type, "Equipment");
});

test("jobId stays null by design — the raising inspection is usually out of our window", () => {
  // Measured: the tenant's deficiencies reference 159 inspections and we hold 2.
  // Location is the only reliable link, which is why v1's building is used.
  const out = normalize.normalizeDeficiency(rawRow(), { companyId: 11, locationId: 42 });
  assert.equal(out.jobId, null);
});

test("severity is captured but never depended on", () => {
  // null on 436 of 439 live rows.
  const out = normalize.normalizeDeficiency(rawRow({ deficiency_status: null }), { companyId: 11, locationId: 1 });
  assert.equal(out.status, null, "stored as-is rather than defaulted to something invented");
});

test("a row with no id is rejected rather than written half-formed", () => {
  assert.equal(normalize.normalizeDeficiency({ inspectpoint_id: null }, { companyId: 11 }), null);
  assert.equal(normalize.normalizeDeficiency(null, { companyId: 11 }), null);
});

test("asset type prefers the one key present on every row", () => {
  // System/Asset Type: 439/439. Equipment type: 75/439.
  assert.equal(normalize.deficiencyAssetType({ payload: { asset_details: { "System/Asset Type": "Equipment", "Equipment type": "Hood" } } }), "Equipment");
  assert.equal(normalize.deficiencyAssetType({ payload: { asset_details: {} } }), null);
  assert.equal(normalize.deficiencyAssetType({}), null);
});
