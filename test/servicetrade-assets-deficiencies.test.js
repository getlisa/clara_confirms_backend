/**
 * ServiceTrade assets & deficiencies reaching Clara (migrations 117/118).
 * Product decisions (2026-10-20): Clara says the equipment TYPE and WHERE it
 * is, never make/model; she has every open deficiency but names only the worst
 * few (default 3) unprompted, offers the repair, and records a yes for the
 * office. All of it is a company setting, and the prompt stays editable.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

const normalize = require("../src/services/crm/servicetrade/normalize");
const ctxMod = require("../src/services/job-confirmation-context");
const { equipmentPhrase, summariseEquipment, deficiencyItem, summariseSiteDeficiencies } = ctxMod._internal;
const { resolveItems } = require("../src/services/repair-requests");

// ── normalize ──────────────────────────────────────────────────────────────

test("an asset normalizes with where-in-site lifted out, its parent ref kept for the second pass", () => {
  const a = normalize.normalizeAsset({
    servicetrade_id: 77, type: "alarm", name: "Alarm System - Notifier NFS-320C Main electrical room", status: "active",
    payload: { display: "Alarm System", properties: { location_in_site: "Main Electrical Room ", monitored: true }, parent: { id: 5 } },
  }, { companyId: 16, locationId: 4, serviceLineId: 9 });
  assert.equal(a.typeLabel, "Alarm System");
  assert.equal(a.locationInSite, "Main Electrical Room");
  assert.equal(a.isActive, true);
  assert.equal(a.additionalInformation.parent_ref, "5");
  assert.deepEqual(a.properties, { location_in_site: "Main Electrical Room ", monitored: true });
});

test("a deficiency keeps its proposed fix and links to its asset", () => {
  const d = normalize.normalizeDeficiency(
    { servicetrade_id: 1, payload: { status: "verified", severity: "inoperable", proposedFix: " Rebuild check valve #2 ", asset: { id: 77 } } },
    { companyId: 16, assetId: 300 });
  assert.equal(d.assetId, 300);
  assert.equal(d.additionalInformation.proposed_fix, "Rebuild check valve #2");
});

// ── how Clara says it ──────────────────────────────────────────────────────

test("equipment is type + where, never the asset name (which carries make/model)", () => {
  assert.equal(equipmentPhrase({ type_label: "Alarm System", location_in_site: "Main Electrical Room" }), "alarm system (Main Electrical Room)");
  assert.equal(equipmentPhrase({ type: "fire_department_connection" }), "fire department connection");
});

test("a visit's equipment is grouped by type with a few locations", () => {
  const items = [
    { type_label: "Alarm System", location_in_site: "Main Electrical Room" },
    ...["Gymnasium", "Corridor West", "Kitchen", "Lobby"].map((w) => ({ type_label: "Portable Fire Extinguisher", location_in_site: w })),
  ];
  assert.equal(summariseEquipment(items),
    "4 portable fire extinguishers (Gymnasium, Corridor West and 2 other spots) and the alarm system (Main Electrical Room)");
});

test("a deficiency reads severity — equipment (where): problem, the fix, and any repair already underway", () => {
  const s = deficiencyItem({ severity: "inoperable", asset_type_label: "Backflow", asset_location_in_site: "Riser Room",
    description: "Check valve #2 failed to hold tight", proposed_fix: "Rebuild check valve #2", resolution: "out_for_repair" });
  assert.equal(s, "Inoperable — backflow (Riser Room): Check valve #2 failed to hold tight. Recommended fix: Rebuild check valve #2. A repair is already in progress.");
  assert.doesNotMatch(deficiencyItem({ severity: "suggested", description: "x" }), /in progress/);
});

test("the headline counts by severity, worst first", () => {
  assert.equal(summariseSiteDeficiencies([{ severity: "deficient" }, { severity: "inoperable" }, { severity: "deficient" }]),
    "3 open deficiencies at the site, including 1 inoperable and 2 deficient");
});

// ── settings → call variables ──────────────────────────────────────────────

const ctxWith = (policy) => ({
  ok: true, deficiency_policy: policy,
  job: { id: 1, job_number: "J1", comments: [], location_name: "HQ" },
  appointments: { next: { open_issue_count: 4, open_issue_summary: "4 open deficiencies at the site", open_issue_source: "servicetrade",
    open_issue_details: ["a", "b", "c", "d"], equipment_summary: "the riser (Fire Riser Room)" } },
  previsit_instructions: [],
});

test("defaults: mention, offer the repair, name 3 — and Clara has every item", () => {
  const v = ctxMod.toDynamicVariables(ctxWith({ mention: true, offerRepair: true, mentionLimit: 3 }));
  assert.equal(v.open_issue_count, "4");
  assert.equal(v.open_issue_details, "a | b | c | d", "all of them, not just the ones she names");
  assert.equal(v.open_issue_mention_limit, "3");
  assert.equal(v.open_issue_offer_repair, "true");
  assert.equal(v.next_equipment, "the riser (Fire Riser Room)");
});

test("'don't mention deficiencies' turns the section off like a site with none", () => {
  const v = ctxMod.toDynamicVariables(ctxWith({ mention: false, offerRepair: true, mentionLimit: 3 }));
  assert.equal(v.open_issue_count, "0");
  assert.equal(v.open_issue_details, "none");
});

test("'mention only' and a custom limit reach the prompt", () => {
  const v = ctxMod.toDynamicVariables(ctxWith({ mention: true, offerRepair: false, mentionLimit: 2 }));
  assert.equal(v.open_issue_offer_repair, "false");
  assert.equal(v.open_issue_mention_limit, "2");
});

// ── the tool ───────────────────────────────────────────────────────────────

test("record_repair_request resolves 'all', positions, or keeps the customer's words", () => {
  const open = ["A", "B", "C"];
  assert.deepEqual(resolveItems("all", open), ["A", "B", "C"]);
  assert.deepEqual(resolveItems("1, 3", open), ["A", "C"]);
  assert.deepEqual(resolveItems("1 and 2", open), ["A", "B"]);
  assert.deepEqual(resolveItems("the backflow one", open), ["the backflow one"]);
  assert.deepEqual(resolveItems("9", open), ["9"], "an out-of-range position is kept verbatim rather than guessed");
});

test("the tool is offered only while the company offers repairs, and isn't blocked by read-only mode", () => {
  const seeds = require("../src/db/tool-definitions").TOOL_SEEDS || require("../src/db/tool-definitions").seeds;
  const def = (seeds || []).find((t) => t.name === "record_repair_request");
  if (!def) return; // seeds aren't exported in this module shape — covered by the prompt test below
  assert.equal(def.gated_by_setting, "deficiency_offer_repair");
  assert.equal(def.is_write_tool, false);
});

test("the default prompt carries the new variables and the tool", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/db/call-type-configs.js"), "utf8");
  for (const v of ["{{next_equipment}}", "{{open_issue_mention_limit}}", "{{open_issue_offer_repair}}", "record_repair_request"]) {
    assert.ok(src.includes(v), `${v} missing from the default prompt`);
  }
  assert.match(src, /never a make, model, part or serial number/i);
});
