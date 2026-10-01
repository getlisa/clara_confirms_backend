/**
 * The partition guard.
 *
 * Deficiencies ride the appointment_services path so the agent sees them
 * without new plumbing. The danger is that `service_lines`, `service_names`,
 * `service_details` AND `service_summary` are all derived from that same set —
 * and `service_summary` is what the agent OPENS THE CALL with. A repair that
 * leaks into those fields makes Kelly announce unscheduled work as booked:
 *
 *   "Hi, I'm calling about your Hood Cleaning and valve tamper switch repair"
 *
 * Every test here exists to keep that from regressing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const dbQueries = [];
stub("db", {
  query: async (sql, params) => {
    const flat = String(sql).replace(/\s+/g, " ");
    dbQueries.push({ sql: flat, params });
    return { rows: [] };
  },
});

stub("utils/timezone", {
  getCompanyTimezone: async () => "America/New_York",
  formatSpokenDateTime: () => "Tuesday 29 September at 11:00 AM",
  formatSpokenDate: () => "Tuesday 29 September",
  formatSpokenTime: () => "11:00 AM",
  formatArrivalWindow: () => "between 10:30 AM and 11:30 AM",
  formatSpokenDateOnly: () => "29 September",
  toLocalDateOnly: (v) => String(v).slice(0, 10),
});

const jobsDb = require("../src/db/jobs");

// ── the query must actually select `kind` ────────────────────────────────────

test("fetchServicesByAppointment selects kind, or the partition has nothing to read", async () => {
  dbQueries.length = 0;
  await jobsDb.fetchServicesByAppointment(11, [1, 2]);
  const q = dbQueries.find((x) => /FROM appointment_services/.test(x.sql));
  assert.ok(q, "the services query ran");
  assert.ok(/aps\.kind/.test(q.sql), "kind is selected — without it every repair reads as a service");
  assert.ok(/aps\.asset/.test(q.sql), "asset carries the equipment family for the summary");
  assert.ok(/aps\.deficiency_id/.test(q.sql), "deficiency_id links back to the canonical row");
});

test("a row with no kind defaults to 'service' — pre-migration rows are real work", async () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/db/jobs.js"), "utf8");
  assert.ok(/kind:\s*r\.kind\s*\|\|\s*"service"/.test(src),
    "defaulted, not assumed present: rows written before migration 110 have no kind");
});

// ── the partition itself ─────────────────────────────────────────────────────

test("the context filters services by kind before building any service_* field", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/job-confirmation-context.js"), "utf8");
  const shapeFn = src.slice(src.indexOf("const shape = (appt"), src.indexOf("// The whole crew"));

  assert.ok(/const svc = allRows\.filter\(\(s\) => \(s\.kind \|\| "service"\) === "service"\)/.test(shapeFn),
    "svc — the set every service_* field derives from — excludes repairs");
  assert.ok(/const repairs = allRows\.filter\(\(s\) => s\.kind === "deficiency_repair"\)/.test(shapeFn),
    "repairs are partitioned into their own set");

  // The ordering matters: the filter must come BEFORE the derivations.
  const filterAt = shapeFn.indexOf("allRows.filter");
  const linesAt = shapeFn.indexOf("const lines = dedupe");
  assert.ok(filterAt > -1 && linesAt > filterAt, "the partition happens before service_lines is built");
});

test("no service_* field is built from the unpartitioned row set", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/job-confirmation-context.js"), "utf8");
  const shapeFn = src.slice(src.indexOf("const shape = (appt"), src.indexOf("return ({"));
  // `allRows` may appear only in the two filters that define svc/repairs.
  const uses = (shapeFn.match(/allRows/g) || []).length;
  assert.equal(uses, 3, `allRows should appear exactly 3 times (declaration + 2 filters), found ${uses}`);
});

// ── the summary's vocabulary ─────────────────────────────────────────────────

test("the spoken summary names only REAL equipment families, never InspectPoint's internals", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/job-confirmation-context.js"), "utf8");
  const fn = src.slice(src.indexOf("const SPEAKABLE_ASSET_TYPES"), src.indexOf("function dedupe"));
  // Assert on the SET LITERAL, not the surrounding prose — the comment above it
  // necessarily quotes the jargon in order to explain why it is excluded.
  const setLiteral = fn.slice(fn.indexOf("new Set(["), fn.indexOf("]);") + 3);

  // Measured across 436 open rows: "Inspection custom inspection" (183),
  // "Asset" (99), "Equipment" (75), "Inspection external form" (66) are 97% of
  // the corpus and mean nothing to a customer on the phone.
  for (const jargon of ["inspection custom inspection", "inspection external form", '"asset"', '"equipment"']) {
    assert.ok(!setLiteral.includes(jargon), `${jargon} must not be in the speakable set`);
  }
  for (const real of ["fire extinguisher", "fire exit sign", "sprinkler"]) {
    assert.ok(setLiteral.includes(real), `${real} is a real family and should be speakable`);
  }
  // The rationale comment sits above the declaration, so check the whole file.
  assert.ok(/opt-IN/i.test(src), "allowlist, not denylist — an unknown value is probably plumbing");
});

test("the cap is documented and small", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/job-confirmation-context.js"), "utf8");
  const m = src.match(/const MAX_SPOKEN_DEFICIENCIES = (\d+)/);
  assert.ok(m, "the cap is a named constant");
  const cap = Number(m[1]);
  // One live site has 29 open items; reading them all would be unusable.
  assert.ok(cap > 0 && cap <= 8, `cap should be small, got ${cap}`);
});

// ── pricing ──────────────────────────────────────────────────────────────────

test("a projected repair NEVER carries a price — CMAP-228 forbids quoting one", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/crm/inspectpoint/provider.js"), "utf8");
  const fn = src.slice(src.indexOf("_projectDeficiencyRepairs"), src.indexOf("async _normalizeCustomers"));
  assert.ok(/estimatedPrice: null/.test(fn), "price is forced null on the projected row");
  assert.ok(/NEVER a price/i.test(fn), "and the reason is recorded where someone might 'fix' it");
});

test("the projection pins to ONE appointment, because the unique index allows only one", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/crm/inspectpoint/provider.js"), "utf8");
  const fn = src.slice(src.indexOf("_projectDeficiencyRepairs"), src.indexOf("async _normalizeCustomers"));
  assert.ok(/DISTINCT ON \(j\.location_id\)/.test(fn), "one appointment per location — the soonest");
  assert.ok(/ORDER BY j\.location_id, a\.scheduled_start/.test(fn), "soonest wins");
  assert.ok(/external_ref_uq|UNIQUE \(company_id/.test(fn), "the constraint that forces this is explained");
  // Every location with deficiencies has MORE than one upcoming visit, so
  // fanning out would offer the same repair on every call.
  assert.ok(/MORE than one upcoming visit/i.test(fn));
});

test("stale repair rows are deleted, so a fixed fault is never re-offered", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/crm/inspectpoint/provider.js"), "utf8");
  const fn = src.slice(src.indexOf("_projectDeficiencyRepairs"), src.indexOf("async _normalizeCustomers"));
  assert.ok(/DELETE FROM appointment_services/.test(fn), "rows no longer projected are removed");
  assert.ok(/kind = 'deficiency_repair'/.test(fn), "and the delete is scoped to repairs — real services are untouched");
});

test("duplicate re-reports are collapsed", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/crm/inspectpoint/provider.js"), "utf8");
  const fn = src.slice(src.indexOf("_projectDeficiencyRepairs"), src.indexOf("async _normalizeCustomers"));
  // 60 of 436 open rows are the same display_name repeated at one site.
  assert.ok(/DISTINCT ON \(d\.location_id, lower\(btrim\(d\.name\)\)\)/.test(fn),
    "same problem re-reported by successive inspections is said once");
});
