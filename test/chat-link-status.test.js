/**
 * Chat-link LIFECYCLE status: sent → in_progress → ended, or expired.
 *
 * Additional to `chat_links.state`, which is untouched. The two answer
 * different questions and conflating them is the reason monitoring did not
 * work before: `state` defaults to 'chat_started' AT CREATION, so a link nobody
 * had opened already read as a started conversation.
 *
 * The interesting rules are all about transitions that must NOT happen:
 *   - re-opening a finished chat must not drag it back out of `ended`
 *   - the expiry sweep must never touch a chat that reached an outcome
 *   - `opened_at` must keep meaning FIRST open, not most recent
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const queries = [];
let queryImpl = async () => ({ rows: [], rowCount: 0 });
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

const chatLinksDb = require("../src/db/chat-links");

function reset() {
  queries.length = 0;
  queryImpl = async () => ({ rows: [], rowCount: 0 });
}
const sqlOf = (fragment) => queries.find((q) => q.sql.includes(fragment));

// ── Opening ─────────────────────────────────────────────────────────────────

test("the first open advances to in_progress; a later one cannot move the status", async () => {
  reset();
  await chatLinksDb.markOpened(7);
  const q = sqlOf("last_opened_at = NOW()");
  assert.ok(q, "the most-recent-view timestamp still moves every time");
  assert.match(q.sql, /status\s*=\s*CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END/,
    "re-opening a finished chat must not drag it back to in_progress");
  assert.match(q.sql, /opened_at = COALESCE\(opened_at, NOW\(\)\)/,
    "opened_at means FIRST open — overwriting it loses when they actually looked");
});

// ── Ending ──────────────────────────────────────────────────────────────────

test("ending is idempotent and keeps the first ended_at", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ id: 1 }], rowCount: 1 });
  const changed = await chatLinksDb.markEnded("tok");
  assert.equal(changed, true);

  const q = sqlOf("SET status = 'ended'");
  assert.match(q.sql, /ended_at = COALESCE\(ended_at, NOW\(\)\)/);
  assert.match(q.sql, /status <> 'ended'/, "a second call must be a no-op, not a re-stamp");
  assert.deepEqual(q.params, ["tok"]);
});

test("ending a chat that was already ended reports no change", async () => {
  reset();
  queryImpl = async () => ({ rows: [], rowCount: 0 });
  assert.equal(await chatLinksDb.markEnded("tok"), false);
});

// ── Expiry ──────────────────────────────────────────────────────────────────

test("the sweep only touches links that never reached an outcome", async () => {
  reset();
  // Returns the ROWS now, not a count: this is the last moment an expiring link
  // is identifiable, and one that already reached an outcome needs its CRM
  // comment written here.
  queryImpl = async () => ({ rows: [{ id: 1, token: "t", company_id: 8, job_id: 5, state: "confirmation_accepted" }], rowCount: 1 });
  const rows = await chatLinksDb.expireStale();
  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]).sort(), ["company_id", "id", "job_id", "state", "token"]);

  const q = sqlOf("SET status = 'expired'");
  assert.match(q.sql, /RETURNING id, token, company_id, job_id, state/,
    "without identity the caller cannot post the comment it owes");
  assert.match(q.sql, /status IN \('sent', 'in_progress'\)/,
    "an ended chat whose link later lapses must never be reported as expired");
  assert.match(q.sql, /expires_at < NOW\(\)/);
  assert.match(q.sql, /expires_at IS NOT NULL/,
    "a link with no expiry set must never be swept");
});

test("expiry catches a half-finished conversation, not just an unopened link", async () => {
  // The stated requirement: expired even if the customer opened it and walked
  // away mid-conversation. That is the in_progress half of the WHERE clause.
  reset();
  queryImpl = async () => ({ rows: [{ id: 1, token: "t", company_id: 8, job_id: 5 }], rowCount: 1 });
  await chatLinksDb.expireStale();
  const q = sqlOf("SET status = 'expired'");
  assert.ok(q.sql.includes("'in_progress'"), "an opened-but-abandoned chat must still lapse");
});

// ── Sending ─────────────────────────────────────────────────────────────────

test("sent_at is stamped once, on delivery", async () => {
  reset();
  await chatLinksDb.markSent("tok");
  const q = sqlOf("SET sent_at");
  assert.match(q.sql, /sent_at = COALESCE\(sent_at, NOW\(\)\)/,
    "a resend must not rewrite when the customer first received it");
  assert.deepEqual(q.params, ["tok"]);
});

// ── Monitoring reads ────────────────────────────────────────────────────────

test("status counts always report all four buckets, including empty ones", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ status: "ended", n: 2 }], rowCount: 1 });
  const counts = await chatLinksDb.statusCounts(8);
  assert.deepEqual(counts, { sent: 0, in_progress: 0, ended: 2, expired: 0 },
    "a dashboard must not have to guess whether a missing key means zero");
});

test("the monitoring list is company-scoped and filterable", async () => {
  reset();
  queryImpl = async (sql) => sql.includes("count(*)")
    ? { rows: [{ n: 12 }], rowCount: 1 }
    : { rows: [{ id: 1, status: "sent" }], rowCount: 1 };

  const out = await chatLinksDb.listForMonitoring(8, { status: "sent", limit: 10, offset: 20 });
  assert.equal(out.total, 12);
  const list = sqlOf("FROM chat_links cl");
  assert.match(list.sql, /cl\.company_id = \$1/, "never leak another tenant's links");
  assert.match(list.sql, /AND cl\.status = \$4/);
  assert.deepEqual(list.params, [8, 10, 20, "sent"]);
});

test("an unfiltered list does not bind a phantom status parameter", async () => {
  reset();
  queryImpl = async (sql) => sql.includes("count(*)") ? { rows: [{ n: 3 }], rowCount: 1 } : { rows: [], rowCount: 0 };
  await chatLinksDb.listForMonitoring(8, {});
  const list = sqlOf("FROM chat_links cl");
  assert.ok(!list.sql.includes("cl.status = $4"));
  assert.deepEqual(list.params, [8, 50, 0]);
});
