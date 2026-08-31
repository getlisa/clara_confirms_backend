/**
 * Per-CRM confirmation-chat workflows (confirmation-agent/workflows/) and
 * their two seams: registry.js's tool-capability gating, and
 * services/crm's resolveSlugForCompany. See workflows/servicetrade.js and
 * workflows/index.js for why this exists — CrmProvider (services/crm/base.js)
 * is sync/normalize only, nothing conversational, so a second CRM with a
 * different chat workflow had no seam to plug into before this.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const queries = [];
let queryImpl = async () => ({ rows: [] });
stub("db", { query: (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

const { getWorkflow, register } = require("../src/confirmation-agent/workflows");
const { getToolsForPhase } = require("../src/confirmation-agent/tools/registry");
const { resolveSlugForCompany, listProviders } = require("../src/services/crm");

function reset() {
  queries.length = 0;
  queryImpl = async () => ({ rows: [] });
}

// ── workflows/index.js ──────────────────────────────────────────────────────

test("getWorkflow resolves a registered slug", () => {
  const wf = getWorkflow("servicetrade");
  assert.equal(wf.slug, "servicetrade");
  assert.equal(typeof wf.checklist, "function");
  assert.equal(wf.capabilities.serviceLink, true);
});

test("getWorkflow falls back to ServiceTrade for an unrecognised slug — never breaks a live turn", () => {
  const wf = getWorkflow("some-future-crm-not-yet-built");
  assert.equal(wf.slug, "servicetrade");
});

test("getWorkflow falls back to ServiceTrade for null/undefined — the graph's own default", () => {
  assert.equal(getWorkflow(undefined).slug, "servicetrade");
  assert.equal(getWorkflow(null).slug, "servicetrade");
});

test("a newly registered workflow is resolvable by its own slug", () => {
  register({ slug: "test-crm-xyz", capabilities: { serviceLink: false } });
  const wf = getWorkflow("test-crm-xyz");
  assert.equal(wf.slug, "test-crm-xyz");
  assert.equal(wf.capabilities.serviceLink, false);
});

// ── tools/registry.js — capability gating ───────────────────────────────────

test("a workflow with serviceLink:false withholds both service-link tools from every phase", () => {
  const workflow = { slug: "no-link-crm", capabilities: { serviceLink: false } };
  for (const phase of ["confirming", "all_confirmed"]) {
    const names = getToolsForPhase(phase, { workflow }).map((t) => t.name);
    assert.ok(!names.includes("resolve_service_link_contact"), `${phase} must not offer resolve_service_link_contact`);
    assert.ok(!names.includes("get_service_link"), `${phase} must not offer get_service_link`);
  }
});

test("a workflow with serviceLink:true (or omitted) keeps both service-link tools", () => {
  const withTrue = getToolsForPhase("confirming", { workflow: { slug: "x", capabilities: { serviceLink: true } } }).map((t) => t.name);
  const withOmitted = getToolsForPhase("confirming", {}).map((t) => t.name);
  for (const names of [withTrue, withOmitted]) {
    assert.ok(names.includes("resolve_service_link_contact"));
    assert.ok(names.includes("get_service_link"));
  }
});

test("no workflow passed at all defaults to every capability on — existing callers/tests keep today's behavior", () => {
  const names = getToolsForPhase("confirming").map((t) => t.name);
  assert.ok(names.includes("resolve_service_link_contact"));
  assert.ok(names.includes("get_service_link"));
});

test("capability gating does not affect tools unrelated to any capability", () => {
  const workflow = { slug: "no-link-crm", capabilities: { serviceLink: false } };
  const names = getToolsForPhase("confirming", { workflow }).map((t) => t.name);
  assert.ok(names.includes("confirm_appointment"));
  assert.ok(names.includes("capture_confirmer_identity"));
});

test("exclusiveTool still bypasses capability gating entirely — a card-trigger turn is forced regardless", () => {
  const workflow = { slug: "no-link-crm", capabilities: { serviceLink: false } };
  const names = getToolsForPhase("confirming", { workflow, exclusiveTool: "get_service_link" }).map((t) => t.name);
  assert.deepEqual(names, ["get_service_link"]);
});

// ── services/crm's resolveSlugForCompany ────────────────────────────────────

test("resolveSlugForCompany defaults to servicetrade when no integration table has an active row", async () => {
  reset();
  const slug = await resolveSlugForCompany(999);
  assert.equal(slug, "servicetrade");
});

test("resolveSlugForCompany returns a provider's slug when its <slug>_integration table has an active row", async () => {
  reset();
  queryImpl = async (sql) => (sql.includes("servicetrade_integration") ? { rows: [{ "?column?": 1 }] } : { rows: [] });
  const slug = await resolveSlugForCompany(8);
  assert.equal(slug, "servicetrade");
  assert.ok(queries.some((q) => q.sql.includes("servicetrade_integration") && q.sql.includes("is_active = true")));
});

test("resolveSlugForCompany degrades to the default if a provider's integration table check throws — never breaks resolution", async () => {
  reset();
  queryImpl = async () => { throw new Error(`relation "servicetrade_integration" does not exist`); };
  const slug = await resolveSlugForCompany(8);
  assert.equal(slug, "servicetrade");
});

test("resolveSlugForCompany only ever checks slugs from listProviders() — never an arbitrary/unvalidated table name", async () => {
  reset();
  await resolveSlugForCompany(8);
  for (const q of queries) {
    assert.ok(listProviders().some((slug) => q.sql.includes(`${slug}_integration`)));
  }
});
