/**
 * InspectPoint recipients and job status.
 *
 * 1. Customers are Buildings (migration 111). A Building never carries an
 *    email and often no phone, so the building's primary contact fills
 *    whichever it lacks — otherwise the record every recipient resolver reads
 *    is unreachable.
 * 2. A job Clara confirmed must show 'confirmed', and survive the next sync.
 *    InspectPoint jobs sit at 'pending', which the status deriver did not own,
 *    and the sync overwrote job status unconditionally.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });

const normalize = require("../src/services/crm/inspectpoint/normalize");

const building = (payload) => ({ inspectpoint_id: "613", payload: { name: "Atexquita (Middletown)", ...payload } });
const contact = (payload) => ({ inspectpoint_id: "77", payload: { name: "Dana Reed", ...payload } });

// ── 1. customer email/phone fallback ────────────────────────────────────────

test("a building with no email takes its primary contact's email", () => {
  const c = normalize.normalizeCustomer(building({ phone_number: "3025550101" }), {
    companyId: 11, primaryContactRow: contact({ email: "dana@example.com", business_phone_number: "3025550199" }),
  });
  assert.equal(c.email, "dana@example.com");
  assert.equal(c.phone, "+13025550101", "the building's own phone still wins");
  assert.deepEqual(c.additionalInformation.contact_fallback, { inspectpoint_contact_id: "77", email_from_contact: true, phone_from_contact: false });
});

test("a building with no phone takes its primary contact's phone (business, then cell, then home)", () => {
  const c = normalize.normalizeCustomer(building({}), {
    companyId: 11, primaryContactRow: contact({ cell_phone_number: "3025550123" }),
  });
  assert.equal(c.phone, "+13025550123");
  assert.equal(c.additionalInformation.contact_fallback.phone_from_contact, true);
});

test("an email typed into the building's billing_name is the building's own email, and wins over the contact's", () => {
  const c = normalize.normalizeCustomer(building({ phone_number: "4104419480", billing_name: " atexquitarestaurant@gmail.com " }), {
    companyId: 11, primaryContactRow: contact({ email: "dana@example.com" }),
  });
  assert.equal(c.email, "atexquitarestaurant@gmail.com");
  assert.equal(c.additionalInformation.contact_fallback.email_from_contact, false);
});

test("a billing_name that is a person or company name is not taken as an email", () => {
  const c = normalize.normalizeCustomer(building({ billing_name: "Acme Property Management" }), { companyId: 11 });
  assert.equal(c.email, null);
});

test("no primary contact: unchanged — building phone, no email", () => {
  const c = normalize.normalizeCustomer(building({ phone_number: "3025550101" }), { companyId: 11 });
  assert.equal(c.email, null);
  assert.equal(c.phone, "+13025550101");
  assert.equal(c.additionalInformation.contact_fallback, null);
});

// ── 2. job status ───────────────────────────────────────────────────────────

const statusSrc = require("node:fs").readFileSync(require.resolve("../src/services/job-confirmation-status.js"), "utf8");

test("'pending' jobs are owned by the status deriver, so they can become 'confirmed'", () => {
  assert.match(statusSrc, /const OWNED_STATUSES = `\('scheduled', 'confirmed', 'completed', 'pending'\)`/);
});

test("a pending job that is not fully confirmed stays 'pending' — never turned into 'scheduled' (that would put it in the call sweep)", () => {
  const derived = statusSrc.slice(statusSrc.indexOf("const DERIVED_STATUS"), statusSrc.indexOf("const OWNED_STATUSES"));
  const confirmedAt = derived.indexOf("THEN 'confirmed'");
  const pendingAt = derived.indexOf("WHEN j.status = 'pending'                            THEN 'pending'");
  const elseAt = derived.indexOf("ELSE 'scheduled'");
  assert.ok(confirmedAt > 0 && pendingAt > confirmedAt && elseAt > pendingAt, "confirmed wins, then pending is kept, then the old default");
});

test("the InspectPoint sync keeps a Clara 'confirmed' job status while InspectPoint still says pending/scheduled", () => {
  const { FIELDS } = require("../src/services/crm/inspectpoint/provider");
  const status = FIELDS.JOB_FIELDS.find((f) => f.column === "status");
  assert.match(status.updateExpr, /WHEN jobs\.status = 'confirmed' AND EXCLUDED\.status IN \('pending','scheduled'\) THEN jobs\.status ELSE EXCLUDED\.status END/);
});

test("the InspectPoint sync re-derives job statuses after normalizing, like ServiceTrade's", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/crm/inspectpoint/provider.js"), "utf8");
  assert.match(src, /counts\.jobStatusesDerived = await syncAllJobStatuses\(companyId\)/);
});
