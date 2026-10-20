/**
 * The web-chat agent gets the same equipment + open-deficiency behaviour as the
 * voice agent (product decisions 2026-10-20): equipment as type + where only;
 * every open item known, only the worst N named unprompted; offer the repair
 * when the company does; record a yes with record_repair_request.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const prompt = require("../src/confirmation-agent/graph/prompt");
const registry = require("../src/confirmation-agent/tools/registry");

const next = (extra = {}) => ({
  appointment_id: 11, scheduled_start_spoken: "Thursday, May 28, 2026 at 10:00 AM", scheduled_end_spoken: null,
  customer_confirmed: false, technician_confirmed: false, technician: null, technicians: [], service_line: null,
  services: [], status: "scheduled", is_next: true,
  equipment_summary: "the alarm system (Main Electrical Room)",
  open_issue_count: 4,
  open_issue_summary: "4 open deficiencies at the site, including 2 inoperable",
  open_issue_details: [
    "Inoperable — backflow (Riser Room): Check valve #2 failed to hold tight. Recommended fix: Rebuild check valve #2.",
    "Inoperable — alarm device (Roof Access): Smoke detector failed sensitivity test. A repair is already in progress.",
    "Deficient — portable fire extinguisher (Rear Exit): Due for 6-year maintenance.",
    "Suggested — exit light (Stairwell A): Battery weak.",
  ],
  ...extra,
});

function ctx({ policy = { mention: true, offerRepair: true, mentionLimit: 3 }, nextExtra = {} } = {}) {
  const n = next(nextExtra);
  return {
    ok: true, phase: "confirming", tz: "America/Chicago", deficiency_policy: policy,
    job: { id: 1, job_number: "J1", title: "Annual inspection", description: null, job_type: "inspection", status: "scheduled",
      scheduled_date: null, comments: [], notes: [], customer: { name: "Acme", phone: null, email: null, address: null }, technician: null },
    appointments: { upcoming: [n], next: n, history: [] },
    counts: { upcoming: 1, confirmed: 0, unconfirmed: 1, all_confirmed: false },
    previsit_instructions: [],
  };
}

test("the chat prompt carries the visit's equipment, type + where only", () => {
  const out = prompt.build(ctx(), { companyName: "ABC Fire" });
  assert.match(out, /The equipment the next visit is for \(type and where it is\): the alarm system \(Main Electrical Room\)/);
  assert.match(out, /never a make, model, part or serial number/);
});

test("OPEN ITEMS lists every item, names only the worst N, treats in-progress as status, offers + records", () => {
  const out = prompt.build(ctx(), { companyName: "ABC Fire" });
  assert.match(out, /OPEN ITEMS AT THIS SITE/);
  assert.match(out, /4\. Suggested — exit light \(Stairwell A\)/, "Clara has all of them");
  assert.match(out, /the first 3 at most/);
  assert.match(out, /are a status — mention them as such and never offer them again/);
  assert.match(out, /call record_repair_request/);
  assert.match(out, /Never say the repair is booked/);
});

test("a custom limit and 'mention only' are respected", () => {
  const out = prompt.build(ctx({ policy: { mention: true, offerRepair: false, mentionLimit: 2 } }), { companyName: "ABC Fire" });
  assert.match(out, /the first 2 at most/);
  assert.match(out, /Do not offer the repair/);
  assert.doesNotMatch(out, /call record_repair_request/);
});

test("'don't mention' — or a site with none — leaves no OPEN ITEMS section at all", () => {
  assert.doesNotMatch(prompt.build(ctx({ policy: { mention: false, offerRepair: true, mentionLimit: 3 } }), { companyName: "ABC Fire" }), /OPEN ITEMS AT THIS SITE/);
  assert.doesNotMatch(prompt.build(ctx({ nextExtra: { open_issue_count: 0, open_issue_details: [] } }), { companyName: "ABC Fire" }), /OPEN ITEMS AT THIS SITE/);
});

test("record_repair_request is bound only when offering repairs AND there are open items, never on the opening turn", () => {
  const names = (opts) => registry.getToolsForPhase("confirming", opts).map((t) => t.name);
  assert.ok(names({ repairOffer: { offerRepair: true, hasOpenIssues: true } }).includes("record_repair_request"));
  assert.ok(!names({ repairOffer: { offerRepair: false, hasOpenIssues: true } }).includes("record_repair_request"));
  assert.ok(!names({ repairOffer: { offerRepair: true, hasOpenIssues: false } }).includes("record_repair_request"));
  assert.ok(!names({ isOpeningTurn: true, repairOffer: { offerRepair: true, hasOpenIssues: true } }).includes("record_repair_request"));
  assert.ok(!registry.getToolsForPhase("no_appointment", { repairOffer: { offerRepair: true, hasOpenIssues: true } }).map((t) => t.name).includes("record_repair_request"));
});
