/**
 * scheduler.js's pre-dial staleness guard.
 *
 * A call is queued by a sweep and dialled later — up to a full CRM-sync
 * interval afterwards — so the job can be cancelled or completed in between.
 * Nothing else in the pipeline re-checks at dial time. Provider-agnostic: the
 * trigger was an InspectPoint gap (we now fetch only open statuses, so an
 * upstream cancellation can go unseen for a while), but the race is identical
 * for ServiceTrade and for a manually-queued row.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

let jobStatus = "scheduled";
const dbCalls = [];
stub("db", {
  query: async (sql, params) => {
    dbCalls.push({ sql, params });
    if (/SELECT status FROM jobs WHERE id/.test(sql)) {
      return { rows: jobStatus === null ? [] : [{ status: jobStatus }] };
    }
    if (/SELECT default_timezone FROM companies/.test(sql)) {
      return { rows: [{ default_timezone: "America/New_York" }] };
    }
    return { rows: [] };
  },
});

const cancelled = [];
let claimRows = [];
stub("db/scheduled-calls", {
  claimPending: async () => claimRows,
  markCancelled: async (id, reason) => { cancelled.push({ id, reason }); },
  markCompleted: async () => {},
  markFailedOrRetry: async () => "failed",
  advanceToNextWindow: async () => {},
  scheduleRetry: async () => {},
  fallbackToLink: async () => {},
});

stub("db/call-settings", { getByCompanyId: async () => ({ business_hours_start: "00:00", business_hours_end: "23:59", include_weekends: true }) });
stub("db/call-type-configs", { getByType: async () => null, getAllByCompanyId: async () => [] });
stub("db/dynamic-variable-definitions", { buildDefaultsForCompany: async () => ({}) });
stub("db/todos", { create: async () => {}, TODO_TYPES: {} });
stub("db/jobs", {});
stub("db/chat-links", {});
stub("db/service-link-messages", {});
stub("db/confirmer-identities", {});
stub("db/confirmation-events", { recordSafe: async () => 1 });
stub("db/agent-settings", { getByCompanyId: async () => ({}) });

const createCalls = [];
stub("services/retell", { createCall: async (args) => { createCalls.push(args); return { call_id: "c1" }; }, getClient: () => ({}) });
stub("services/chat-links", {});
stub("services/servicetrade-sync", {});
stub("services/job-confirmation-context", { buildJobConfirmationContext: async () => ({ ok: true }) });
stub("services/job-confirmation-status", { syncJobConfirmationStatus: async () => {} });
stub("services/job-confirmation-inference", { inferJobConfirmations: async () => {} });
stub("services/call-hydration", { HYDRATORS: {} });

const scheduler = require("../src/services/scheduler");

function baseRow(overrides = {}) {
  return {
    id: 1, company_id: 7, job_id: 900, call_type: "customer_confirmation",
    phone_number: "+15551234567", channel: "voice", attempt_number: 0,
    customer_name: "Dana", job_name: "J", is_test: false, scheduled_at: new Date().toISOString(),
    ...overrides,
  };
}

function reset(status) {
  jobStatus = status;
  dbCalls.length = 0;
  cancelled.length = 0;
  createCalls.length = 0;
  claimRows = [baseRow()];
}

test("a queued call whose job was CANCELLED after enqueue is never dialled", async () => {
  reset("cancelled");
  const r = await scheduler.runDispatcher(5);
  assert.equal(createCalls.length, 0, "must not place the call");
  assert.equal(cancelled.length, 1);
  assert.match(cancelled[0].reason, /cancelled/i);
  assert.equal(r.skipped, 1);
});

test("a queued call whose job was COMPLETED after enqueue is never dialled", async () => {
  reset("completed");
  await scheduler.runDispatcher(5);
  assert.equal(createCalls.length, 0);
  assert.equal(cancelled.length, 1);
});

test("the guard cancels terminally rather than retrying — retrying is the wrong response to 'the work no longer exists'", async () => {
  reset("cancelled");
  await scheduler.runDispatcher(5);
  assert.equal(cancelled.length, 1, "markCancelled, not markFailedOrRetry");
});

test("a still-scheduled job is dialled normally — the guard must not block live work", async () => {
  reset("scheduled");
  await scheduler.runDispatcher(5);
  assert.equal(cancelled.length, 0);
});

test("a row with no job_id skips the lookup entirely rather than querying for null", async () => {
  reset("scheduled");
  claimRows = [baseRow({ job_id: null })];
  await scheduler.runDispatcher(5);
  assert.equal(dbCalls.filter((c) => /SELECT status FROM jobs/.test(c.sql)).length, 0);
  assert.equal(cancelled.length, 0);
});
