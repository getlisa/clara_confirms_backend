/**
 * routes/retell.js's wasAlreadyFulfilledLive — the check that stops the
 * post-call LLM classifier's ASKED_FOR_CANCELLATION/ASKED_FOR_RESCHEDULE
 * verdict from raising a redundant (or actively misleading) escalation todo
 * when the agent already fulfilled that exact request LIVE via the real tool
 * during the same call.
 *
 * Regression case (observed live 2026-09-09, call_a90e16d79c1f09f84366fc5556e,
 * company 12 / job 139506): the customer asked to reschedule two visits, the
 * agent booked both live via reschedule_appointment, then confirmed both via
 * confirm_job_appointments — a fully-resolved call. Retell's own post-call
 * classifier still set `reschedule_requested: true` (it only knows "the
 * customer asked", not "and it was already handled"), so deriveTodoType kept
 * raising ASKED_FOR_RESCHEDULE ("needs staff follow-up") on a job that was
 * already rescheduled and re-confirmed on the platform.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());
stub("services/retell", { verifyWebhookSignature: async () => true });
stub("db/calls", {});
stub("db/call-logs", {});
stub("db/call-settings", {});
stub("db/scheduled-calls", {});
stub("services/servicetrade-comments", {});
stub("services/servicetrade-service-link", {});
stub("services/scheduler", {});
stub("services/callback-time", {});
stub("services/channel-resolver", {});

let queryCalls = [];
let queryImpl = async () => ({ rows: [] });
stub("db", { query: async (sql, params) => queryImpl(sql, params) });

const { TODO_TYPES } = require("../src/db/todos");
const { wasAlreadyFulfilledLive } = require("../src/routes/retell");

function reset() {
  queryCalls = [];
}

test("returns false without querying anything for a todoType that isn't cancellation/reschedule", async () => {
  reset();
  queryImpl = async (sql, params) => { queryCalls.push({ sql, params }); return { rows: [] }; };
  const result = await wasAlreadyFulfilledLive(TODO_TYPES.UNCONFIRMED, 12, "call_x");
  assert.equal(result, false);
  assert.equal(queryCalls.length, 0);
});

test("ASKED_FOR_CANCELLATION: true when additional_information carries this call's cancelled_by_agent_call_id stamp", async () => {
  reset();
  queryImpl = async (sql, params) => {
    queryCalls.push({ sql, params });
    return /cancelled_by_agent_call_id/.test(sql) ? { rows: [{ "?column?": 1 }] } : { rows: [] };
  };
  const result = await wasAlreadyFulfilledLive(TODO_TYPES.ASKED_FOR_CANCELLATION, 12, "call_a90e16d79c1f09f84366fc5556e");
  assert.equal(result, true);
  assert.deepEqual(queryCalls[0].params, [12, "call_a90e16d79c1f09f84366fc5556e"]);
});

test("ASKED_FOR_CANCELLATION: false when no matching stamp exists", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  const result = await wasAlreadyFulfilledLive(TODO_TYPES.ASKED_FOR_CANCELLATION, 12, "call_never_cancelled");
  assert.equal(result, false);
});

test("ASKED_FOR_RESCHEDULE: true when a 'rescheduled' confirmation_events row exists for this exact call (the live regression case)", async () => {
  reset();
  queryImpl = async (sql, params) => {
    queryCalls.push({ sql, params });
    return /FROM confirmation_events/.test(sql) && /event_type = 'rescheduled'/.test(sql)
      ? { rows: [{ "?column?": 1 }] }
      : { rows: [] };
  };
  const result = await wasAlreadyFulfilledLive(TODO_TYPES.ASKED_FOR_RESCHEDULE, 12, "call_a90e16d79c1f09f84366fc5556e");
  assert.equal(result, true, "a call that already rescheduled live must suppress the redundant ASKED_FOR_RESCHEDULE todo");
  assert.deepEqual(queryCalls[0].params, [12, "call_a90e16d79c1f09f84366fc5556e"]);
});

test("ASKED_FOR_RESCHEDULE: false when the customer asked but nothing was actually rescheduled live — the genuine escalation case", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  const result = await wasAlreadyFulfilledLive(TODO_TYPES.ASKED_FOR_RESCHEDULE, 12, "call_asked_but_no_time_given");
  assert.equal(result, false, "a genuinely unresolved reschedule request must still raise the escalation todo");
});
