/**
 * ServiceTrade webhooks — realtime push alongside the hourly poll.
 *
 * Three published delivery rules drive nearly every decision here, and each one
 * is a silent-data-loss bug if broken:
 *
 *   1. 5 SECONDS to respond, 3 attempts, then the message is DISCARDED
 *      PERMANENTLY. So the receiver does one INSERT and returns; it must never
 *      grow a ServiceTrade call or per-entity work.
 *   2. ANY status in 200-499 counts as a SUCCESSFUL delivery. A 404 or 403 is
 *      therefore not a rejection — it throws the event away. The receiver must
 *      never answer 4xx, and must answer 5xx only when a retry could help.
 *   3. Messages may arrive OUT OF ORDER and MORE THAN ONCE, and one message
 *      batches many entities.
 *
 * ServiceTrade also sends no signature, no HMAC and no secret header — verified
 * against the full published spec — so the URL secret is the only authentication
 * and these tests pin that it actually gates.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);

// ── Fake db, recording every statement so we can assert on the SQL shape ─────

const queries = [];
let queryImpl = async () => ({ rows: [], rowCount: 0 });
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

const stCalls = [];
let stImpl = async () => ({ ok: true, status: 200, data: {}, messages: {} });
stub("services/servicetrade", {
  request: async (companyId, method, path, opts) => {
    stCalls.push({ companyId, method, path, body: opts?.body });
    return stImpl(companyId, method, path, opts);
  },
});

stub("db/servicetrade-credentials", { getByCompanyId: async () => ({ username: "u", authCode: "PHPSESSID=x" }) });

const syncCalls = [];
let syncImpl = async () => ({ success: true, counts: { jobs: 1 }, targeted: true });
stub("services/servicetrade-sync", {
  runSync: async (companyId, options) => { syncCalls.push({ companyId, options }); return syncImpl(companyId, options); },
  requestWithRetry: async (companyId, method, path) => {
    stCalls.push({ companyId, method, path, viaRetry: true });
    return stImpl(companyId, method, path, {});
  },
});

const normalizeCalls = [];
stub("services/crm/servicetrade/provider", { normalizeAll: async (companyId) => { normalizeCalls.push(companyId); return {}; } });

const webhooksDb = require("../src/db/servicetrade-webhooks");
const receiver = require("../src/routes/servicetrade-webhooks");
const registration = require("../src/services/servicetrade-webhook-registration");

function reset() {
  queries.length = 0; stCalls.length = 0; syncCalls.length = 0; normalizeCalls.length = 0;
  queryImpl = async () => ({ rows: [], rowCount: 0 });
  stImpl = async () => ({ ok: true, status: 200, data: {}, messages: {} });
  syncImpl = async () => ({ success: true, counts: { jobs: 1 }, targeted: true });
  logger.reset();
}

// A realistic message, copied from the shape in the published docs.
const SECRET = "s".repeat(43);
function message(overrides = {}) {
  return {
    messageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
    timestamp: "1401833057",
    data: [{
      action: "updated",
      timestamp: 1401833052,
      userId: 1234,
      entity: { type: "appointment", id: 34872, uri: "https://api.servicetrade.com/api/appointment/34872" },
      changeset: [{ field: "status", oldValue: "scheduled", newValue: "completed" }],
    }],
    ...overrides,
  };
}

async function startReceiver() {
  const app = express();
  app.use(express.json());
  app.use("/webhooks/servicetrade", receiver);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  return server;
}

async function post(server, path, body) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── Rule 2: never 4xx ───────────────────────────────────────────────────────

test("an unknown secret is answered 200, not 404", async () => {
  reset();
  queryImpl = async () => ({ rows: [], rowCount: 0 }); // no subscription matches
  const server = await startReceiver();
  try {
    const res = await post(server, `/webhooks/servicetrade/${SECRET}`, message());
    assert.equal(res.status, 200,
      "a 4xx counts as a successful delivery, so refusing loudly only discards the event");
    assert.equal(res.body.received, true);
  } finally { server.close(); }
});

test("a malformed body is answered 200 and nothing is enqueued", async () => {
  reset();
  queryImpl = async (sql) => sql.includes("FROM servicetrade_webhook_subscriptions")
    ? { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 }
    : { rows: [], rowCount: 0 };
  const server = await startReceiver();
  try {
    for (const body of [{}, { messageId: "m1" }, { messageId: "m1", data: "not-an-array" }, { data: [] }]) {
      const res = await post(server, `/webhooks/servicetrade/${SECRET}`, body);
      assert.equal(res.status, 200, `body ${JSON.stringify(body)} must still be acked`);
    }
    assert.equal(queries.filter((q) => q.sql.includes("INSERT INTO servicetrade_webhook_events")).length, 0);
  } finally { server.close(); }
});

test("a database failure IS answered 5xx — the one case a retry can save", async () => {
  reset();
  queryImpl = async () => { throw new Error("connection terminated"); };
  const server = await startReceiver();
  try {
    const res = await post(server, `/webhooks/servicetrade/${SECRET}`, message());
    assert.equal(res.status, 503,
      "the event was not stored, so this must be the one status that gets redelivered");
  } finally { server.close(); }
});

test("an enqueue failure is also 5xx, not a silent ack", async () => {
  reset();
  queryImpl = async (sql) => {
    if (sql.includes("FROM servicetrade_webhook_subscriptions")) return { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
    if (sql.includes("INSERT INTO servicetrade_webhook_events")) throw new Error("deadlock detected");
    return { rows: [], rowCount: 0 };
  };
  const server = await startReceiver();
  try {
    const res = await post(server, `/webhooks/servicetrade/${SECRET}`, message());
    assert.equal(res.status, 503);
  } finally { server.close(); }
});

// ── Rule 1: the receiver stays cheap ────────────────────────────────────────

test("the receiver never calls ServiceTrade", async () => {
  reset();
  queryImpl = async (sql) => sql.includes("FROM servicetrade_webhook_subscriptions")
    ? { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 }
    : { rows: [], rowCount: 1 };
  const server = await startReceiver();
  try {
    await post(server, `/webhooks/servicetrade/${SECRET}`, message());
    assert.equal(stCalls.length, 0,
      "one outbound call would risk the 5s budget and lose the message after 3 retries");
    assert.equal(syncCalls.length, 0, "and syncing inline would blow it outright");
  } finally { server.close(); }
});

// ── Rule 3: batching, dedupe, ordering ─────────────────────────────────────

test("every entity in one batched message is enqueued", async () => {
  reset();
  let inserted = null;
  queryImpl = async (sql, params) => {
    if (sql.includes("FROM servicetrade_webhook_subscriptions")) return { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
    if (sql.includes("INSERT INTO servicetrade_webhook_events")) { inserted = params; return { rows: [], rowCount: 3 }; }
    return { rows: [], rowCount: 0 };
  };
  const server = await startReceiver();
  try {
    await post(server, `/webhooks/servicetrade/${SECRET}`, message({
      data: [
        { action: "created", timestamp: 1401833052, entity: { type: "job", id: 1 } },
        { action: "updated", timestamp: 1401833052, entity: { type: "appointment", id: 2 } },
        { action: "deleted", timestamp: 1401833052, entity: { type: "contact", id: 3 } },
      ],
    }));
    // 9 bound params per row.
    assert.equal(inserted.length, 27, "all three entities, not just the first");
    assert.deepEqual([inserted[3], inserted[12], inserted[21]], ["job", "appointment", "contact"]);
  } finally { server.close(); }
});

test("unmodelled entity types are dropped without an insert", async () => {
  reset();
  queryImpl = async (sql) => sql.includes("FROM servicetrade_webhook_subscriptions")
    ? { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 }
    : { rows: [], rowCount: 0 };
  const server = await startReceiver();
  try {
    const res = await post(server, `/webhooks/servicetrade/${SECRET}`, message({
      data: [
        { action: "updated", timestamp: 1, entity: { type: "invoice", id: 1 } },
        { action: "updated", timestamp: 1, entity: { type: "clockevent", id: 2 } },
      ],
    }));
    assert.equal(res.status, 200);
    assert.equal(queries.filter((q) => q.sql.includes("INSERT INTO servicetrade_webhook_events")).length, 0);
  } finally { server.close(); }
});

test("the dedupe key is per-entity, not per-message", async () => {
  // One messageId legitimately carries many entities. Deduping on message_id
  // alone would keep only the first entity of every batch.
  reset();
  let sql = null;
  queryImpl = async (s, params) => {
    if (s.includes("FROM servicetrade_webhook_subscriptions")) return { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
    if (s.includes("INSERT INTO servicetrade_webhook_events")) { sql = s; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  const server = await startReceiver();
  try {
    await post(server, `/webhooks/servicetrade/${SECRET}`, message());
    assert.match(sql, /ON CONFLICT \(company_id, message_id, entity_type, entity_id, action\) DO NOTHING/);
  } finally { server.close(); }
});

test("timestamps are read as unix SECONDS", async () => {
  reset();
  let params = null;
  queryImpl = async (s, p) => {
    if (s.includes("FROM servicetrade_webhook_subscriptions")) return { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
    if (s.includes("INSERT INTO servicetrade_webhook_events")) { params = p; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  const server = await startReceiver();
  try {
    await post(server, `/webhooks/servicetrade/${SECRET}`, message());
    assert.equal(params[6].toISOString(), new Date(1401833052 * 1000).toISOString(),
      "reading them as milliseconds would date every event to 1970 and break ordering");
  } finally { server.close(); }
});

test("a system-triggered change has a null actor, not a zero", async () => {
  reset();
  let params = null;
  queryImpl = async (s, p) => {
    if (s.includes("FROM servicetrade_webhook_subscriptions")) return { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
    if (s.includes("INSERT INTO servicetrade_webhook_events")) { params = p; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  const server = await startReceiver();
  try {
    await post(server, `/webhooks/servicetrade/${SECRET}`, message({
      data: [{ action: "updated", timestamp: 1, userId: null, entity: { type: "job", id: 5 } }],
    }));
    assert.equal(params[7], null);
  } finally { server.close(); }
});

test("the changeset is preserved — it is why includeChangesets is on", async () => {
  reset();
  let params = null;
  queryImpl = async (s, p) => {
    if (s.includes("FROM servicetrade_webhook_subscriptions")) return { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
    if (s.includes("INSERT INTO servicetrade_webhook_events")) { params = p; return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  const server = await startReceiver();
  try {
    await post(server, `/webhooks/servicetrade/${SECRET}`, message());
    assert.deepEqual(JSON.parse(params[8]), [{ field: "status", oldValue: "scheduled", newValue: "completed" }]);
  } finally { server.close(); }
});

test("an oversized batch is capped and logged as an error, not silently trimmed", async () => {
  reset();
  queryImpl = async (s) => s.includes("FROM servicetrade_webhook_subscriptions")
    ? { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 }
    : { rows: [], rowCount: 1 };
  const server = await startReceiver();
  try {
    const data = Array.from({ length: receiver.MAX_EVENTS_PER_MESSAGE + 5 }, (_, i) => ({
      action: "updated", timestamp: 1, entity: { type: "job", id: i + 1 },
    }));
    await post(server, `/webhooks/servicetrade/${SECRET}`, message({ data }));
    assert.equal(logger.records.error.length, 1,
      "dropping real changes must be loud — a warn would scroll past unnoticed");
  } finally { server.close(); }
});

// ── parseEvent, directly ────────────────────────────────────────────────────

test("parseEvent rejects what it cannot act on", async () => {
  for (const bad of [
    null, {}, { action: "updated" },
    { action: "frobnicated", entity: { type: "job", id: 1 } },
    { action: "updated", entity: { type: "job" } },
    { action: "updated", entity: { type: "job", id: 0 } },
    { action: "updated", entity: { type: "job", id: -1 } },
    { action: "updated", entity: { type: "job", id: "abc" } },
    { action: "updated", entity: { id: 1 } },
  ]) {
    assert.equal(receiver.parseEvent(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test("parseEvent lowercases action and type so casing cannot split the dedupe key", async () => {
  const e = receiver.parseEvent({ action: "UPDATED", entity: { type: "Job", id: 7 } });
  assert.equal(e.action, "updated");
  assert.equal(e.entityType, "job");
});

// ── The queue's claim semantics ─────────────────────────────────────────────

test("claiming uses SKIP LOCKED so concurrent drains cannot double-process", async () => {
  reset();
  let sql = null;
  queryImpl = async (s) => { sql = s; return { rows: [], rowCount: 0 }; };
  await webhooksDb.claimPending(8, 10);
  assert.match(sql, /FOR UPDATE SKIP LOCKED/,
    "the every-minute cron and a refresh-button click WILL overlap");
  assert.match(sql, /attempts = e\.attempts \+ 1/, "an unincremented attempt count would retry forever");
  assert.match(sql, /ORDER BY received_at/);
});

test("claiming reclaims rows stranded in 'processing' by a killed invocation", async () => {
  reset();
  let sql = null;
  queryImpl = async (s) => { sql = s; return { rows: [], rowCount: 0 }; };
  await webhooksDb.claimPending(8, 10);
  assert.match(sql, /status = 'processing' AND claimed_at </,
    "a serverless timeout mid-drain would otherwise strand events forever");
  assert.match(sql, /attempts < \$3/, "but a poisoned event must eventually stop being retried");
});

test("a done event records which job it was applied to", async () => {
  reset();
  const seen = [];
  queryImpl = async (s, p) => { seen.push({ s, p }); return { rows: [], rowCount: 1 }; };
  await webhooksDb.markDoneWithRefs([{ id: 1, jobRef: "2274033731792769" }, { id: 2, jobRef: "999" }]);
  assert.equal(seen.length, 1, "one statement, not one per event");
  assert.deepEqual(seen[0].p[1], ["2274033731792769", "999"]);
  assert.match(seen[0].s, /unnest/);
});

test("markDoneWithRefs on an empty list issues no query", async () => {
  reset();
  queryImpl = async () => ({ rows: [], rowCount: 0 });
  await webhooksDb.markDoneWithRefs([]);
  assert.equal(queries.length, 0);
});

test("findBySecret refuses a short secret without touching the database", async () => {
  reset();
  assert.equal(await webhooksDb.findBySecret("short"), null);
  assert.equal(await webhooksDb.findBySecret(null), null);
  assert.equal(queries.length, 0);
});

test("generated secrets are long, URL-safe and unique", async () => {
  const a = webhooksDb.generateSecret();
  const b = webhooksDb.generateSecret();
  assert.notEqual(a, b);
  assert.ok(a.length >= 42, `expected a long secret, got ${a.length} chars`);
  assert.match(a, /^[A-Za-z0-9_-]+$/,
    "it lives in a URL path stored on ServiceTrade's side; + / = would need escaping");
});

// ── Registration ────────────────────────────────────────────────────────────

test("registration refuses a non-public base URL instead of registering a dead hook", async () => {
  reset();
  for (const baseUrl of ["", "http://localhost:3000", "http://example.com"]) {
    const r = await registration.register(8, { baseUrl });
    assert.equal(r.ok, false, `${baseUrl || "(empty)"} must be rejected`);
  }
  assert.equal(stCalls.length, 0);
});

test("registering twice updates the existing subscription rather than adding a second", async () => {
  // ServiceTrade delivers every message to EVERY webhook on the account, so a
  // duplicate subscription means processing every change twice, forever.
  reset();
  queryImpl = async (s) => {
    if (s.includes("INSERT INTO servicetrade_webhook_subscriptions")) {
      return { rows: [{ company_id: 8, secret: SECRET, servicetrade_webhook_id: "555", hook_url: `https://api.test/webhooks/servicetrade/${SECRET}` }], rowCount: 1 };
    }
    return { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
  };
  stImpl = async () => ({ ok: true, status: 200, data: { id: 555, hookUrl: "x", enabled: true, confirmed: true }, messages: {} });
  const r = await registration.register(8, { baseUrl: "https://api.test" });
  assert.equal(r.ok, true);
  assert.deepEqual(stCalls.map((c) => c.method), ["PUT"], "POST would create a duplicate subscription");
  assert.match(stCalls[0].path, /^\/webhook\/555$/);
});

test("a changed base URL deletes the old subscription before creating the new one", async () => {
  // hookUrl is immutable on PUT, so repointing means delete-then-create;
  // skipping the delete would leave ServiceTrade posting to the old host too.
  reset();
  queryImpl = async (s) => {
    if (s.includes("INSERT INTO servicetrade_webhook_subscriptions")) {
      return { rows: [{ company_id: 8, secret: SECRET, servicetrade_webhook_id: "555", hook_url: "https://old.host/webhooks/servicetrade/" + SECRET }], rowCount: 1 };
    }
    return { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
  };
  stImpl = async () => ({ ok: true, status: 200, data: { id: 777, hookUrl: "x", enabled: true, confirmed: false }, messages: {} });
  const r = await registration.register(8, { baseUrl: "https://new.host" });
  assert.equal(r.ok, true);
  assert.deepEqual(stCalls.map((c) => c.method), ["DELETE", "POST"]);
});

test("registration subscribes to exactly the six entity types we model", async () => {
  reset();
  queryImpl = async (s) => s.includes("INSERT INTO servicetrade_webhook_subscriptions")
    ? { rows: [{ company_id: 8, secret: SECRET, servicetrade_webhook_id: null, hook_url: null }], rowCount: 1 }
    : { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
  stImpl = async () => ({ ok: true, status: 200, data: { id: 1, confirmed: false }, messages: {} });
  await registration.register(8, { baseUrl: "https://api.test" });

  const body = stCalls[0].body;
  assert.deepEqual(body.entityEvents.map((e) => e.entityType).sort((a, b) => a - b), [3, 4, 5, 11, 16, 22],
    "job, user, company, location, appointment, contact — a wrong constant subscribes to the wrong entity");
  assert.equal(body.includeChangesets, true,
    "changesets carry appointment status/windowStart/windowEnd and job status — our whole domain");
  assert.equal(body.hookUrl, `https://api.test/webhooks/servicetrade/${SECRET}`);
});

test("a 403 from ServiceTrade is surfaced as 403 — it means admin.account is missing", async () => {
  reset();
  queryImpl = async (s) => s.includes("INSERT INTO servicetrade_webhook_subscriptions")
    ? { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 }
    : { rows: [{ company_id: 8, secret: SECRET }], rowCount: 1 };
  stImpl = async () => ({ ok: false, status: 403, data: null, messages: { error: ["Permission denied"] } });
  const r = await registration.register(8, { baseUrl: "https://api.test" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test("the secret is never included in the shape returned to callers", async () => {
  const shape = registration.publicShape({
    company_id: 8, secret: "SUPER-SECRET", servicetrade_webhook_id: "1",
    hook_url: "https://api.test/webhooks/servicetrade/SUPER-SECRET",
    enabled: true, confirmed: true, entity_events: [], last_message_at: null,
  });
  assert.equal(shape.secret, undefined,
    "it is the sole credential for a public unauthenticated endpoint");
  assert.ok(!Object.keys(shape).includes("secret"));
});

// ── The drain ───────────────────────────────────────────────────────────────

const processor = require("../src/services/servicetrade-webhook-processor");

/**
 * Wire the fake db to answer the drain's three query shapes: the claim, the
 * appointment→job lookup, and the mark-* updates.
 */
function drainDb({ claimed = [], apptJob = null, related = [] } = {}) {
  const marks = [];
  queryImpl = async (sql, params) => {
    if (sql.includes("UPDATE servicetrade_webhook_events e") && sql.includes("claimable")) {
      return { rows: claimed, rowCount: claimed.length };
    }
    if (sql.includes("FROM servicetrade_appointments")) {
      return { rows: apptJob ? [{ servicetrade_job_id: apptJob }] : [], rowCount: apptJob ? 1 : 0 };
    }
    if (sql.includes("UPDATE servicetrade_webhook_events")) {
      marks.push({ sql, params }); return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM jobs j") || sql.includes("FROM contacts ct")) {
      return { rows: related.map((external_ref) => ({ external_ref })), rowCount: related.length };
    }
    return { rows: [], rowCount: 0 };
  };
  return marks;
}

const ev = (over = {}) => ({ id: 1, action: "updated", entity_type: "job", entity_id: "2274033731792769", ...over });

test("the drain applies one targeted sync for the union of resolved jobs", async () => {
  reset();
  drainDb({ claimed: [ev({ id: 1, entity_id: "111" }), ev({ id: 2, entity_id: "222" }), ev({ id: 3, entity_id: "111" })] });
  const out = await processor.drainCompany(8);

  assert.equal(syncCalls.length, 1, "one sync per drain pass, not one per event");
  assert.deepEqual(syncCalls[0].options.jobIds.sort(), ["111", "222"], "duplicate job ids collapse");
  assert.deepEqual(normalizeCalls, [8], "raw rows are useless until normalized");
  assert.equal(out.synced, true);
});

test("the drain never triggers a full sync", async () => {
  reset();
  drainDb({ claimed: [ev()] });
  await processor.drainCompany(8);
  assert.equal(syncCalls[0].options.full, undefined,
    "a webhook must not kick off a month-wide fetch");
  assert.ok(Array.isArray(syncCalls[0].options.jobIds));
});

test("a failed sync returns the whole batch to pending and skips normalize", async () => {
  reset();
  const marks = drainDb({ claimed: [ev({ id: 1 }), ev({ id: 2, entity_id: "222" })] });
  syncImpl = async () => ({ success: false, error: "ServiceTrade 500" });
  const out = await processor.drainCompany(8);

  assert.equal(out.synced, false);
  assert.equal(normalizeCalls.length, 0, "normalizing after a failed fetch would confirm nothing new");
  const failed = marks.find((m) => m.sql.includes("WHEN attempts >="));
  assert.ok(failed, "the events must go back to pending, not be marked done");
  assert.deepEqual(failed.params[0], [1, 2], "the whole batch, since nothing was refreshed");
});

test("an event that touches no job is skipped, not retried forever", async () => {
  reset();
  const marks = drainDb({ claimed: [ev({ entity_type: "location", entity_id: "9" })], related: [] });
  const out = await processor.drainCompany(8);
  assert.equal(syncCalls.length, 0);
  assert.ok(marks.some((m) => m.sql.includes("status = 'skipped'")));
  assert.equal(out.synced, false);
});

test("a disconnected integration returns events to pending rather than dropping them", async () => {
  reset();
  const marks = drainDb({ claimed: [ev()] });
  const creds = require("../src/db/servicetrade-credentials");
  const original = creds.getByCompanyId;
  creds.getByCompanyId = async () => null;
  try {
    const out = await processor.drainCompany(8);
    assert.equal(out.synced, false);
    assert.equal(syncCalls.length, 0);
    assert.ok(marks.some((m) => m.sql.includes("WHEN attempts >=")), "must be retryable after a reconnect");
  } finally { creds.getByCompanyId = original; }
});

test("an empty queue does no work at all", async () => {
  reset();
  drainDb({ claimed: [] });
  const out = await processor.drainCompany(8);
  assert.deepEqual(out, { claimed: 0, jobIds: [], synced: false });
  assert.equal(syncCalls.length, 0);
  assert.equal(normalizeCalls.length, 0);
});

test("an appointment event resolves through the local table without an API call", async () => {
  reset();
  drainDb({ claimed: [ev({ entity_type: "appointment", entity_id: "34872" })], apptJob: "2274033731792769" });
  await processor.drainCompany(8);
  assert.deepEqual(syncCalls[0].options.jobIds, ["2274033731792769"]);
  assert.equal(stCalls.length, 0, "the local raw table already knows the job");
});

test("an unknown appointment is looked up upstream — except when deleted", async () => {
  reset();
  drainDb({ claimed: [ev({ entity_type: "appointment", entity_id: "77" })], apptJob: null });
  stImpl = async () => ({ ok: true, status: 200, data: { job: { id: 4242 } }, messages: {} });
  await processor.drainCompany(8);
  assert.equal(stCalls.length, 1);
  assert.deepEqual(syncCalls[0].options.jobIds, ["4242"]);

  reset();
  drainDb({ claimed: [ev({ entity_type: "appointment", entity_id: "77", action: "deleted" })], apptJob: null });
  await processor.drainCompany(8);
  assert.equal(stCalls.length, 0, "the record is already gone; the fetch would only 404");
});

test("job ids stay strings — Number() would eventually corrupt one", async () => {
  reset();
  // 2^53 + 1: the first integer Number cannot represent exactly.
  drainDb({ claimed: [ev({ entity_id: "9007199254740993" })] });
  await processor.drainCompany(8);
  assert.deepEqual(syncCalls[0].options.jobIds, ["9007199254740993"],
    "as a Number this becomes 9007199254740992 and fetches a different job");
});

test("a garbage entity id is dropped rather than fetched", async () => {
  reset();
  const marks = drainDb({ claimed: [ev({ entity_id: "not-an-id" })] });
  await processor.drainCompany(8);
  assert.equal(syncCalls.length, 0);
  assert.ok(marks.some((m) => m.sql.includes("status = 'skipped'")));
});

test("one unresolvable event does not stop the rest of the batch", async () => {
  reset();
  const marks = drainDb({ claimed: [ev({ id: 1, entity_id: "bad" }), ev({ id: 2, entity_id: "222" })] });
  const out = await processor.drainCompany(8);
  assert.deepEqual(syncCalls[0].options.jobIds, ["222"]);
  assert.equal(out.synced, true);
  assert.ok(marks.some((m) => m.sql.includes("status = 'skipped'")));
});
