/**
 * The daily report's collectors — one per sheet. Every one must be scoped to
 * ONE company, real (non-test) rows only, and the right date window in the
 * COMPANY's timezone — a UTC leak here silently shifts every number in the
 * report by hours and shows up as "wrong day's data".
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const queries = [];
let queryImpl = async () => ({ rows: [] });
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

// collectOutreach sources from logs.js's OWN unified query, not raw db.query —
// see collect.js for why (a manual send has no scheduled_calls row at all).
const logsCalls = [];
let logsRows = [];
stub("db/logs", { listForRange: async (companyId, opts) => { logsCalls.push({ companyId, ...opts }); return logsRows; } });

const collect = require("../src/services/daily-report/collect");

function reset() { queries.length = 0; queryImpl = async () => ({ rows: [] }); logsCalls.length = 0; logsRows = []; }
const find = (frag) => queries.find((q) => q.sql.includes(frag));

// A company on America/Chicago, business day 2026-08-13 → the query window
// should be exactly [2026-08-13T05:00:00Z, 2026-08-14T05:00:00Z) (CDT, -05:00).
const CO = 8, DATE = "2026-08-13", TZ = "America/Chicago";
const EXPECT_FROM = "2026-08-13T05:00:00.000Z";
const EXPECT_TO = "2026-08-14T05:00:00.000Z";

test("collectOutreach delegates to logs.js's listForRange with the right window and call_type", async () => {
  reset();
  await collect.collectOutreach(CO, DATE, TZ);
  assert.equal(logsCalls.length, 1);
  assert.deepEqual(logsCalls[0], { companyId: CO, from: EXPECT_FROM, to: EXPECT_TO, callType: "customer_confirmation" });
});

test("collectOutreach: a voice/call-source row is judged 'responded' by whether the call connected", async () => {
  reset();
  logsRows = [
    { source: "call", channel: "call", job_id: "1", job_name: "J", job_number: "1", recipient_name: "C",
      recipient_phone: "+15551234567", recipient_email: null, timestamp: new Date(),
      record: { channel: "voice", to_number: "+15551234567", disconnection_reason: "dial_no_answer" } },
    { source: "call", channel: "call", job_id: "1", job_name: "J", job_number: "1", recipient_name: "C",
      recipient_phone: "+15551234567", recipient_email: null, timestamp: new Date(),
      record: { channel: "voice", to_number: "+15551234567", disconnection_reason: "agent_hangup" } },
  ];
  const rows = await collect.collectOutreach(CO, DATE, TZ);
  assert.equal(rows[0].responded, false, "no-answer is not a response");
  assert.equal(rows[0].opened, null, "a call has no concept of 'opened'");
  assert.equal(rows[1].responded, true, "the call connected and ran");
});

test("collectOutreach: a chat-source row is judged 'opened'/'responded' from the link's own status", async () => {
  reset();
  logsRows = [
    { source: "chat", channel: "chat", job_id: "1", job_name: "J", job_number: "1", recipient_name: "Dana",
      recipient_phone: null, recipient_email: "d@x.test", timestamp: new Date(),
      record: { status: "sent", opened_at: null } },
  ];
  const [row] = await collect.collectOutreach(CO, DATE, TZ);
  assert.equal(row.opened, false);
  assert.equal(row.responded, false, "sent but never opened is not a response");
});

test("collectOutreach includes a chat link with NO scheduled_calls row at all (a manual send)", async () => {
  // The whole point of sourcing from logs.js: a manually-triggered send-email
  // creates no scheduled_calls row, and must not silently disappear from the
  // report. logs.js's chat half reads chat_links directly, so it never has
  // this gap in the first place — this pins that collectOutreach relies on
  // that, rather than re-deriving its own scheduled_calls-based query.
  reset();
  logsRows = [
    { source: "chat", channel: "chat", job_id: "1", job_name: "J", job_number: "1", recipient_name: "Dana",
      recipient_phone: null, recipient_email: "d@x.test", timestamp: new Date(),
      record: { status: "ended", opened_at: new Date(), origin: "manual", triggered_by_name: "Jane Staff" } },
  ];
  const rows = await collect.collectOutreach(CO, DATE, TZ);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recipient_name, "Dana");
});

test("collectOutreach picks the destination and raw channel from the nested `record`", async () => {
  reset();
  logsRows = [
    { source: "call", channel: "call", job_id: "1", job_name: "J", job_number: "1", recipient_name: "C",
      recipient_phone: "+15550000000", recipient_email: null, timestamp: new Date(),
      // A legacy Retell-hosted chat/sms session lives in `calls` too — its
      // TOP-LEVEL channel is collapsed to 'call' by logs.js, but record.channel
      // still carries the real value.
      record: { channel: "sms", to_number: "+15559999999", disconnection_reason: "agent_hangup" } },
  ];
  const [row] = await collect.collectOutreach(CO, DATE, TZ);
  assert.equal(row.channel, "sms", "the granular channel, not logs.js's collapsed call/chat one");
  assert.equal(row.destination, "+15559999999", "record.to_number — the number the call/session actually used");
});

test("collectConfirmed reads ONLY confirmation_events, real rows, this window", async () => {
  reset();
  await collect.collectConfirmed(CO, DATE, TZ);
  const q = find("FROM confirmation_events ce");
  assert.match(q.sql, /ce\.company_id = \$1 AND ce\.is_test = false AND ce\.event_type = 'confirmed'/);
  assert.deepEqual(q.params, [CO, EXPECT_FROM, EXPECT_TO]);
});

test("collectReschedules and collectCancellations are scoped to their own event_type", async () => {
  reset();
  await collect.collectReschedules(CO, DATE, TZ);
  assert.match(find("FROM confirmation_events ce").sql, /event_type = 'rescheduled'/);
  reset();
  await collect.collectCancellations(CO, DATE, TZ);
  assert.match(find("FROM confirmation_events ce").sql, /event_type = 'cancelled'/);
});

test("collectAwaitingResponse only looks at links from EARLIER days, still unresolved", async () => {
  reset();
  await collect.collectAwaitingResponse(CO, DATE, TZ);
  const q = find("FROM chat_links cl");
  assert.match(q.sql, /cl\.status IN \('sent', 'in_progress'\)/,
    "an ended or expired link has already reached its outcome — must not reappear here");
  assert.match(q.sql, /cl\.sent_at < \$2/, "strictly before TODAY's window start, not within it");
  assert.deepEqual(q.params, [CO, EXPECT_FROM]);
});

test("collectAwaitingResponse computes age in whole days and an 'opened' flag", async () => {
  reset();
  const sentAt = new Date(Date.parse(EXPECT_FROM) - 3 * 86400000); // 3 days before today's window start
  queryImpl = async () => ({ rows: [
    { id: 1, sent_at: sentAt, status: "in_progress", state: "chat_started", opened_at: sentAt,
      recipient_name: "Dana", recipient_email: "d@x.test", recipient_phone: null,
      job_number: "1", job_name: "J", location_name: "Site" },
  ] });
  const [row] = await collect.collectAwaitingResponse(CO, DATE, TZ);
  assert.equal(row.age_days, 3);
  assert.equal(row.opened, true);
  assert.equal(typeof row.sent_date_local, "string");
});

test("collectActionItems: only open/in_progress, real, this company — a snapshot, not date-scoped", async () => {
  reset();
  await collect.collectActionItems(CO);
  const q = find("FROM todos t");
  assert.match(q.sql, /t\.company_id = \$1 AND t\.is_test = false AND t\.status IN \('open', 'in_progress'\)/);
  assert.deepEqual(q.params, [CO]);
});

test("collectSummary cross-checks the ledger against appointments' own confirmed_at stamp", async () => {
  reset();
  let call = 0;
  queryImpl = async (sql) => {
    call += 1;
    if (sql.includes("FROM appointments")) return { rows: [{ n: 3 }] };
    return { rows: [] };
  };
  const s = await collect.collectSummary(CO, DATE, TZ);
  assert.equal(s.confirmed_count_appointments_crosscheck, 3);
  assert.equal(s.business_date, DATE);
});
