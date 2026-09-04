/**
 * Phase 3 — the CRM write-back dispatch seam. Two things under test:
 *
 * 1. getProviderForSource(): the safe resolver actions.js/retell-tools.js/
 *    retell.js use instead of importing a concrete CRM module. Must never
 *    throw — a manually-created row (source=null) or a retired/unknown
 *    source string must degrade to "no provider", not break a live action.
 *
 * 2. ServiceTradeProvider's mirror methods are thin delegates to the
 *    PRE-EXISTING servicetrade-appointments.js/servicetrade-comments.js
 *    functions — this is a behavior-preserving refactor, so the test proves
 *    zero behavior change: same function, same args, called exactly once.
 *
 * Also covers the circular-require trap this work sits next to: provider.js
 * requires servicetrade-appointments.js/servicetrade-comments.js LAZILY
 * (inside each method, not at module top) specifically because both pull in
 * servicetrade-api.js, which does an eager `require("./crm")` — and this
 * provider is itself required BY crm/index.js while registering providers.
 * A top-level require would close that cycle mid-load.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [] }) });

// Stub the two modules ServiceTradeProvider's mirrors delegate to, and record
// every call so we can assert exact pass-through.
const appointmentCalls = [];
stub("services/servicetrade-appointments", {
  mirrorRescheduleAppointment: async (...args) => { appointmentCalls.push(["mirrorRescheduleAppointment", args]); return { ok: true, via: "reschedule" }; },
  mirrorCreateAppointment: async (...args) => { appointmentCalls.push(["mirrorCreateAppointment", args]); return { ok: true, via: "create" }; },
  mirrorRescheduleJob: async (...args) => { appointmentCalls.push(["mirrorRescheduleJob", args]); return { ok: true, via: "rescheduleJob" }; },
  mirrorCancelAppointment: async (...args) => { appointmentCalls.push(["mirrorCancelAppointment", args]); return { ok: true, via: "cancel" }; },
  mirrorCancelJob: async (...args) => { appointmentCalls.push(["mirrorCancelJob", args]); return { ok: true, via: "cancelJob" }; },
});

const commentCalls = [];
stub("services/servicetrade-comments", {
  postConfirmationAgentComment: async (params) => { commentCalls.push(["postConfirmationAgentComment", params]); return { ok: true }; },
  postCallComment: async (params) => { commentCalls.push(["postCallComment", params]); return { ok: true }; },
});

// Everything servicetrade-sync/provider.js's OTHER (unrelated) code paths
// need, so requiring the module doesn't blow up on missing stubs.
stub("services/servicetrade", {});
stub("services/servicetrade-sync", {});
stub("db/servicetrade-sync", {});
stub("db/servicetrade-credentials", { getByCompanyId: async () => null });
stub("db/technicians", {});
stub("db/call-settings", {});
stub("services/job-confirmation-inference", { inferJobConfirmations: async () => {} });
stub("services/job-confirmation-status", { syncAllJobStatuses: async () => {} });

const { getProviderForSource, getProvider } = require("../src/services/crm");
const inspectPointProvider = require("../src/services/crm/inspectpoint/provider");

function reset() {
  appointmentCalls.length = 0;
  commentCalls.length = 0;
}

// ── getProviderForSource ─────────────────────────────────────────────────────

test("getProviderForSource resolves a registered slug, same as getProvider", () => {
  const p = getProviderForSource("servicetrade");
  assert.equal(p.slug, "servicetrade");
});

test("getProviderForSource(null) returns null — a manually-created row (no CRM source) must never throw", () => {
  assert.equal(getProviderForSource(null), null);
  assert.equal(getProviderForSource(undefined), null);
  assert.equal(getProviderForSource(""), null);
});

test("getProviderForSource returns null for an unrecognized/retired source, never throws", () => {
  assert.equal(getProviderForSource("some_retired_crm"), null);
});

test("getProvider (unsafe) still throws on an unknown slug — getProviderForSource is the deliberately different one", () => {
  assert.throws(() => getProvider("some_retired_crm"), /Unknown CRM provider/);
});

// ── ServiceTradeProvider mirror delegates — exact pass-through ──────────────

test("mirrorRescheduleAppointment delegates to servicetrade-appointments.js with identical args and returns its result unchanged", async () => {
  reset();
  const provider = getProviderForSource("servicetrade");
  const appt = { id: 1, source: "servicetrade", external_ref: "999" };
  const opts = { scheduledStart: "2026-09-10T13:00:00Z", scheduledEnd: null, retellCallId: "call-1" };
  const result = await provider.mirrorRescheduleAppointment(9, appt, opts);
  assert.deepEqual(appointmentCalls, [["mirrorRescheduleAppointment", [9, appt, opts]]]);
  assert.deepEqual(result, { ok: true, via: "reschedule" });
});

test("mirrorCreateAppointment delegates with (companyId, appointment, platformJobId, opts)", async () => {
  reset();
  const provider = getProviderForSource("servicetrade");
  const appt = { id: 2, source: "manual", external_ref: null };
  await provider.mirrorCreateAppointment(9, appt, 55, { scheduledStart: "x" });
  assert.deepEqual(appointmentCalls, [["mirrorCreateAppointment", [9, appt, 55, { scheduledStart: "x" }]]]);
});

test("mirrorRescheduleJob and mirrorCancelJob delegate with (companyId, job, opts)", async () => {
  reset();
  const provider = getProviderForSource("servicetrade");
  const job = { id: 3, source: "servicetrade", external_ref: "777" };
  await provider.mirrorRescheduleJob(9, job, { scheduledDate: "2026-09-15" });
  await provider.mirrorCancelJob(9, job, { retellCallId: "call-2" });
  assert.deepEqual(appointmentCalls, [
    ["mirrorRescheduleJob", [9, job, { scheduledDate: "2026-09-15" }]],
    ["mirrorCancelJob", [9, job, { retellCallId: "call-2" }]],
  ]);
});

test("mirrorCancelAppointment delegates with (companyId, appointment, opts)", async () => {
  reset();
  const provider = getProviderForSource("servicetrade");
  const appt = { id: 4, source: "servicetrade", external_ref: "888" };
  await provider.mirrorCancelAppointment(9, appt, { retellCallId: "call-3" });
  assert.deepEqual(appointmentCalls, [["mirrorCancelAppointment", [9, appt, { retellCallId: "call-3" }]]]);
});

test("mirrorPostChatComment merges companyId into the params object for postConfirmationAgentComment", async () => {
  reset();
  const provider = getProviderForSource("servicetrade");
  await provider.mirrorPostChatComment(9, { jobId: 1, threadId: "t1", summaryLines: ["confirmed"] });
  assert.deepEqual(commentCalls, [["postConfirmationAgentComment", { companyId: 9, jobId: 1, threadId: "t1", summaryLines: ["confirmed"] }]]);
});

test("mirrorPostCallComment merges companyId into the params object for postCallComment", async () => {
  reset();
  const provider = getProviderForSource("servicetrade");
  await provider.mirrorPostCallComment(9, { scheduledCall: { id: 1 }, outcome: {}, retellCallId: "call-4" });
  assert.deepEqual(commentCalls, [["postCallComment", { companyId: 9, scheduledCall: { id: 1 }, outcome: {}, retellCallId: "call-4" }]]);
});

// ── Base-class no-op defaults ────────────────────────────────────────────────
//
// Tested against a fresh, minimal CrmProvider subclass rather than
// InspectPoint — InspectPoint now genuinely implements all seven (Phase 4),
// so it's the wrong fixture for "a provider that hasn't implemented this
// yet." A future third CRM that hasn't implemented everything is exactly
// what this guards.

test("a provider that hasn't implemented a mirror method gets the base class's no-op default, not an error", async () => {
  const { CrmProvider } = require("../src/services/crm/base");
  class BareProvider extends CrmProvider {
    get slug() { return "bare"; }
  }
  const bare = new BareProvider();
  const result = await bare.mirrorRescheduleAppointment(9, {}, {});
  assert.deepEqual(result, { skipped: "not_supported" });
});

test("every mirror method exists on both providers — InspectPoint with real implementations, a bare subclass with the base defaults", async () => {
  const { CrmProvider } = require("../src/services/crm/base");
  class BareProvider extends CrmProvider {
    get slug() { return "bare"; }
  }
  const bare = new BareProvider();
  const methods = ["mirrorRescheduleAppointment", "mirrorCreateAppointment", "mirrorRescheduleJob", "mirrorCancelAppointment", "mirrorCancelJob", "mirrorPostChatComment", "mirrorPostCallComment"];
  for (const m of methods) {
    assert.equal(typeof inspectPointProvider[m], "function", `InspectPoint must implement ${m} (Phase 4)`);
    assert.equal(typeof bare[m], "function", `${m} must have a base-class default for a provider that hasn't implemented it`);
  }
});
