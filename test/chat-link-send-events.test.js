/**
 * Per-send log for chat links.
 *
 * The question it exists to answer: "was this emailed or texted FIRST, by whom,
 * how many times, and did it go out?" None of that was recoverable:
 *
 *   - chat_links.origin is LATEST-WINS, so the first trigger type is gone the
 *     moment a link is re-sent;
 *   - the manual send routes create no scheduled_calls row, so a hand re-send
 *     left no timestamp and no evidence beyond flipping that column;
 *   - scheduled_calls is not a history OF A LINK — 57 of 81 real rows point at a
 *     chat_links row that no longer exists.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);

const queries = [];
let queryImpl = async () => ({ rows: [{ id: 1 }], rowCount: 1 });
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

const events = require("../src/db/chat-link-send-events");

function reset() { queries.length = 0; queryImpl = async () => ({ rows: [{ id: 1 }], rowCount: 1 }); logger.reset(); }
const find = (frag) => queries.find((q) => q.sql.includes(frag));

// ── Writing ─────────────────────────────────────────────────────────────────

test("a send records the medium, destination, origin and outcome", async () => {
  reset();
  await events.record({
    companyId: 8, token: "tok", chatLinkId: 5, medium: "sms",
    destination: "+15551234567", origin: "manual", triggeredByUserId: 42, ok: true,
  });
  const q = find("INSERT INTO chat_link_send_events");
  assert.deepEqual(q.params.slice(0, 7), [8, "tok", 5, "sms", "+15551234567", "manual", 42]);
  assert.match(q.sql, /FROM users u WHERE u\.id = \$7::int/,
    "the sender's name is snapshotted, so the record does not change when a user is renamed");
});

test("a FAILED send is logged too — that is the evidence a customer asks about", async () => {
  reset();
  await events.record({
    companyId: 8, token: "tok", medium: "email", destination: "x@y.test",
    origin: "scheduler", ok: false, error: "SendGrid 550",
  });
  const q = find("INSERT INTO chat_link_send_events");
  // params: companyId, token, chatLinkId, medium, destination, origin,
  //         triggeredByUserId, scheduledCallId, ok, error, providerMessageId
  assert.equal(q.params[8], false);
  assert.equal(q.params[9], "SendGrid 550");
});

test("a long provider error is truncated rather than rejected", async () => {
  reset();
  await events.record({ companyId: 8, token: "t", medium: "sms", origin: "scheduler", ok: false, error: "x".repeat(5000) });
  assert.equal(find("INSERT INTO chat_link_send_events").params[9].length, 1000);
});

test("logging never fails the send it describes", async () => {
  reset();
  queryImpl = async () => { throw new Error("table gone"); };
  const id = await events.recordSafe({ companyId: 8, token: "t", medium: "sms", origin: "manual" });
  assert.equal(id, null, "swallowed");
  assert.equal(logger.records.warn.length, 1, "but visible in the logs");
});

// ── Reading ─────────────────────────────────────────────────────────────────

test("the history is oldest-first and company-scoped", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await events.listForToken(8, "tok");
  const q = find("FROM chat_link_send_events");
  assert.match(q.sql, /ORDER BY created_at, id/, "oldest first — 'which came first' is the question");
  assert.match(q.sql, /company_id = \$1 AND chat_link_token = \$2/,
    "never leak another tenant's send history");
});

test("the aggregate distinguishes FIRST from LAST", async () => {
  // The whole point: chat_links.origin only knows the latest.
  const sql = events.AGGREGATE_SQL;
  assert.match(sql, /array_agg\(origin\s+ORDER BY created_at, id\)\)\[1\]\s+AS first_origin/);
  assert.match(sql, /array_agg\(origin\s+ORDER BY created_at DESC, id DESC\)\)\[1\]\s+AS last_origin/);
  assert.match(sql, /count\(\*\)::int\s+AS send_count/);
  assert.match(sql, /count\(\*\) FILTER \(WHERE NOT ok\)::int\s+AS failed_count/,
    "a link whose only sends failed must be distinguishable from one never sent");
  assert.match(sql, /WHERE e\.chat_link_token = cl\.token/, "correlated to the link, lateral-joined");
});

test("ties break deterministically, so first and last never flip between reads", async () => {
  const sql = events.AGGREGATE_SQL;
  assert.ok(sql.includes("created_at, id"), "id breaks a same-timestamp tie ascending");
  assert.ok(sql.includes("created_at DESC, id DESC"), "and descending");
});
