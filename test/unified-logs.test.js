/**
 * Unified logs — the four things the frontend asked for
 * (logs-unified-backend.md), and the traps in each.
 *
 * 1. server-side `search` on both list endpoints, phone matched digits-only
 * 2. `location_name` on GET /calls
 * 3. `recipient_phone` on GET /chat-links
 * 4. GET /logs — one correctly-paginated merged list
 *
 * The correctness argument for #4 is that two independently-paginated sources
 * CANNOT be merged client-side: page 2 of a merge of two `LIMIT 50` queries is
 * not the continuation of page 1. That is pinned here on SQL shape, and against
 * real data in the manual check recorded in the commit message.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const queries = [];
let queryImpl = async () => ({ rows: [], rowCount: 0 });
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

const callsDb = require("../src/db/calls");
const chatLinksDb = require("../src/db/chat-links");
const logsDb = require("../src/db/logs");

function reset() { queries.length = 0; queryImpl = async () => ({ rows: [], rowCount: 0 }); }
const find = (frag) => queries.find((q) => q.sql.includes(frag));

// ── 1. Search ───────────────────────────────────────────────────────────────

test("phone search strips formatting on BOTH sides", async () => {
  // Real data holds both "+19402324304" and "(402) 620-5042", so an ILIKE on the
  // raw column matches whichever format the user happened to type and misses the
  // other.
  reset();
  await callsDb.list(8, { search: "(402) 620-5042" });
  const q = find("FROM calls c");
  assert.match(q.sql, /regexp_replace\(COALESCE\(c\.to_number, ''\), '\\D', '', 'g'\) LIKE/);
  assert.ok(q.params.includes("%4026205042%"), "the query is normalised to digits too");
});

test("a text-only search binds no phone parameter", async () => {
  reset();
  await callsDb.list(8, { search: "lutheran" });
  const q = find("FROM calls c");
  assert.ok(q.params.includes("%lutheran%"));
  assert.ok(!q.params.some((p) => /^%\d+%$/.test(String(p))),
    "no digits in the query means no phone clause to bind");
});

test("search covers all four advertised fields, on both endpoints", async () => {
  reset();
  await callsDb.list(8, { search: "acme" });
  const calls = find("FROM calls c").sql;
  for (const f of ["cu.full_name", "cu.email", "l.name", "c.to_number"]) {
    assert.ok(calls.includes(f), `calls search should cover ${f}`);
  }

  reset();
  queryImpl = async (sql) => sql.includes("count(*)::int AS n") ? { rows: [{ n: 0 }] } : { rows: [] };
  await chatLinksDb.listForMonitoring(8, { search: "acme" });
  const chats = find("FROM chat_links cl").sql;
  for (const f of ["cu.full_name", "ct.email", "l.name", "ct.phone"]) {
    assert.ok(chats.includes(f), `chat search should cover ${f}`);
  }
});

test("a searched chat-link total counts the searched set, not everything", async () => {
  // Otherwise pagination walks off the end of a filtered list.
  reset();
  const seen = [];
  queryImpl = async (sql, params) => {
    seen.push({ sql, params });
    return sql.includes("count(*)::int AS n") ? { rows: [{ n: 2 }] } : { rows: [] };
  };
  const out = await chatLinksDb.listForMonitoring(8, { status: "sent", search: "acme" });
  assert.equal(out.total, 2);
  const count = seen.find((q) => q.sql.includes("count(*)::int AS n"));
  assert.match(count.sql, /cl\.status = \$2/, "the count applies the same filters");
  assert.ok(count.sql.includes("ILIKE"), "including the search");
  assert.ok(count.sql.includes("LEFT JOIN contacts ct"), "and the joins the search needs");
});

// ── 2 & 3. The missing columns ──────────────────────────────────────────────

test("GET /calls resolves the location through scheduled_calls, cast-safely", async () => {
  reset();
  await callsDb.list(8, {});
  const q = find("FROM calls c").sql;
  assert.match(q, /l\.name AS location_name/);
  // scheduled_calls.job_id is VARCHAR and holds non-numeric refs like TEST-SO-1;
  // a bare ::int cast throws on the first one.
  assert.match(q, /NULLIF\(regexp_replace\(COALESCE\(sc\.job_id, ''\), '\[\^0-9\]', '', 'g'\), ''\)::int/);
  assert.ok(!/j\.id = sc\.job_id::int/.test(q), "an unguarded cast would error on non-numeric job ids");
});

test("GET /chat-links prefers the dispatch number, then falls back to contacts.mobile", async () => {
  // phone is null on 820 of 5,828 real contacts with the number in mobile, and
  // the dispatcher's own phone_number is more authoritative still — it is the
  // number the text actually went to.
  reset();
  queryImpl = async (sql) => sql.includes("count(*)::int AS n") ? { rows: [{ n: 0 }] } : { rows: [] };
  await chatLinksDb.listForMonitoring(8, {});
  assert.match(find("FROM chat_links cl").sql,
    /COALESCE\(sc\.phone_number, ct\.phone, ct\.mobile\) AS recipient_phone/);
});

// ── 4. The merged endpoint ──────────────────────────────────────────────────

test("both sources are merged and ordered ONCE, so pages continue each other", async () => {
  reset();
  queryImpl = async (sql) => sql.includes("count(*)::int AS n") ? { rows: [] } : { rows: [] };
  await logsDb.list(8, { limit: 50, offset: 50 });

  const q = find("UNION ALL");
  assert.ok(q, "one query spanning both sources");
  assert.match(q.sql, /ORDER BY timestamp DESC/, "a single ordering over the union");
  assert.match(q.sql, /LIMIT \$\d+ OFFSET \$\d+/, "paged after merging, not before");
  assert.ok(q.sql.indexOf("ORDER BY") > q.sql.indexOf("UNION ALL"),
    "ordering must come after the union — ordering each half separately is the bug this replaces");
});

test("the merged query's job join is cast-safe too", async () => {
  // The same VARCHAR job_id → INTEGER jobs.id hazard exists in both queries, and
  // fixing it in one place is easy to mistake for fixing it everywhere.
  reset();
  queryImpl = async () => ({ rows: [] });
  await logsDb.list(8, {});
  const sql = find("UNION ALL").sql;
  assert.match(sql, /NULLIF\(regexp_replace\(COALESCE\(sc\.job_id, ''\), '\[\^0-9\]', '', 'g'\), ''\)::int/);
  assert.ok(!/j\.id = sc\.job_id::int/.test(sql),
    "a bare cast throws on the first non-numeric job ref");
});

test("channel=chat excludes the calls half entirely, binding no orphan parameters", async () => {
  // Binding the excluded half's params leaves an unreferenced placeholder and
  // Postgres rejects the whole statement with 42P18.
  reset();
  queryImpl = async () => ({ rows: [] });
  await logsDb.list(8, { channel: "chat" });
  const q = find("UNION ALL") || find("FROM chat_links cl");
  assert.ok(!q.sql.includes("FROM calls c"), "the calls half is gone");
  const highest = Math.max(...[...q.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
  assert.equal(highest, q.params.length, "every bound parameter is referenced");
});

test("a call-only filter drops the chat half, and vice versa", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await logsDb.list(8, { outcome: "yes" });
  assert.ok(!find("FROM chat_links cl"), "chat links have no call outcome to satisfy");

  reset();
  await logsDb.list(8, { status: "expired" });
  assert.ok(!find("FROM calls c"), "calls have no chat lifecycle status");
});

test("contradictory filters return an empty page instead of a broken query", async () => {
  reset();
  const out = await logsDb.list(8, { channel: "call", status: "sent" });
  assert.deepEqual(out, { rows: [], counts: { call: 0, chat: 0 }, total: 0 });
  assert.equal(queries.length, 0, "nothing that cannot match should reach the database");
});

test("test mode excludes chat links rather than mixing them with test calls", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await logsDb.list(8, { isTest: true });
  assert.ok(!find("FROM chat_links cl"), "chat_links has no is_test flag");
  assert.ok(find("FROM calls c").sql.includes("c.is_test = $2"));
});

test("SMS and web_chat calls report as the chat channel, not a third one", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await logsDb.list(8, {});
  assert.match(find("UNION ALL").sql,
    /CASE WHEN c\.channel IN \('web_chat', 'sms'\) THEN 'chat' ELSE 'call' END/,
    "there are exactly two channels; delivery medium is not one");
});

test("the nested record omits the heavy and the secret", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await logsDb.list(8, {});
  const sql = find("UNION ALL").sql;
  assert.match(sql, /to_jsonb\(c\.\*\) - 'transcript' - 'raw_analysis'/,
    "a list endpoint must not ship every transcript");
  assert.match(sql, /to_jsonb\(cl\.\*\) - 'token' - 'short_code' - 'short_url'/,
    "the chat token IS the credential for that conversation — never in a list response");
});

// ── 3a/3b. The send record: how it went out, to whom, and who sent it ────────

test("the medium comes from the dispatch record, never defaulted", async () => {
  reset();
  queryImpl = async (sql) => sql.includes("count(*)::int AS n") ? { rows: [{ n: 0 }] } : { rows: [] };
  await chatLinksDb.listForMonitoring(8, {});
  const sql = find("FROM chat_links cl").sql;
  assert.match(sql, /sc\.link_delivery/);
  assert.match(sql, /WHERE s\.chat_link_token = cl\.token/,
    "sourced from the link's own dispatch record");
  assert.ok(!/COALESCE\(sc\.link_delivery, '(email|sms)'\)/.test(sql),
    "a hand-copied link has no medium; guessing one is worse than admitting the gap");
});

test("the recipient email prefers the address the dispatcher actually used", async () => {
  // scheduled_calls.recipient_email is NULL on every real row — the address
  // travels in call_context.override_email, because ServiceTrade-synced
  // customers rarely have an email on the customer record.
  reset();
  queryImpl = async (sql) => sql.includes("count(*)::int AS n") ? { rows: [{ n: 0 }] } : { rows: [] };
  await chatLinksDb.listForMonitoring(8, {});
  assert.match(find("FROM chat_links cl").sql,
    /COALESCE\(sc\.recipient_email, sc\.call_context->>'override_email', ct\.email\) AS recipient_email/);
});

test("phone search matches the SAME expression the row displays", async () => {
  // Displaying sc.phone_number while searching only the contact columns means a
  // number visible in the table returns nothing when typed into the search box.
  reset();
  queryImpl = async (sql) => sql.includes("count(*)::int AS n") ? { rows: [{ n: 0 }] } : { rows: [] };
  await chatLinksDb.listForMonitoring(8, { search: "4026794505" });
  const sql = find("FROM chat_links cl").sql;
  const display = /COALESCE\(sc\.phone_number, ct\.phone, ct\.mobile\) AS recipient_phone/.test(sql);
  const searched = /regexp_replace\(COALESCE\(COALESCE\(sc\.phone_number, ct\.phone, ct\.mobile\), ''\)/.test(sql);
  assert.ok(display, "displays the dispatch number first");
  assert.ok(searched, "and searches the identical expression");
});

test("a manual send is attributed to the person who clicked, snapshotted", async () => {
  reset();
  await chatLinksDb.setOrigin("tok", { origin: "manual", userId: 42 });
  const q = find("UPDATE chat_links");
  assert.match(q.sql, /origin = \$2/);
  assert.match(q.sql, /FROM users u WHERE u\.id = \$3::int/,
    "the name is resolved at write time — an audit trail must not change when a user is renamed");
  assert.deepEqual(q.params, ["tok", "manual", 42]);
});

test("no user means no name, rather than an invented one", async () => {
  reset();
  await chatLinksDb.setOrigin("tok", { origin: "scheduler", userId: null });
  const q = find("UPDATE chat_links");
  assert.match(q.sql, /WHEN \$3::int IS NULL THEN NULL/);
  assert.deepEqual(q.params, ["tok", "scheduler", null]);
});

// ── One row per link, whatever the dispatch history ─────────────────────────

test("a re-sent link yields ONE row, not one per dispatch", async () => {
  // A plain LEFT JOIN on chat_link_token fanned every link into duplicates —
  // one real token has 16 scheduled_calls rows, and 5 links were reported as 17.
  reset();
  queryImpl = async (sql) => sql.includes("count(*)::int AS n") ? { rows: [{ n: 0 }] } : { rows: [] };
  await chatLinksDb.listForMonitoring(8, {});
  const sql = find("FROM chat_links cl").sql;
  assert.match(sql, /LEFT JOIN LATERAL \(/, "the dispatch must be picked, not joined");
  assert.match(sql, /ORDER BY s\.updated_at DESC NULLS LAST, s\.id DESC\s*\n?\s*LIMIT 1/,
    "and it must be the most recent one, deterministically");
  assert.ok(!/LEFT JOIN scheduled_calls sc ON sc\.chat_link_token/.test(sql),
    "the fanning-out join must be gone");
});

test("the count query dedupes the same way as the list", async () => {
  // Otherwise the badge says 17 while the table shows 5.
  reset();
  const seen = [];
  queryImpl = async (sql) => { seen.push(sql); return sql.includes("count(*)::int AS n") ? { rows: [{ n: 5 }] } : { rows: [] }; };
  await chatLinksDb.listForMonitoring(8, {});
  const count = seen.find((q) => q.includes("count(*)::int AS n"));
  assert.match(count, /LEFT JOIN LATERAL \(/);
});

test("/logs dedupes the chat half too", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await logsDb.list(8, { channel: "chat" });
  const sql = find("FROM chat_links cl").sql;
  assert.match(sql, /LEFT JOIN LATERAL \(/);
});

// ── Manual vs scheduler on the calls side ───────────────────────────────────

test("GET /calls reports who triggered the call", async () => {
  reset();
  await callsDb.list(8, {});
  const sql = find("FROM calls c").sql;
  for (const f of ["sc.origin", "sc.triggered_by_user_id", "sc.triggered_by_name"]) {
    assert.ok(sql.includes(f), `should select ${f}`);
  }
});

test("a manually-triggered call records the person, snapshotted at insert", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ id: 1 }] });
  const scheduledCallsDb = require("../src/db/scheduled-calls");
  await scheduledCallsDb.create({
    companyId: 8, callType: "customer_confirmation", phoneNumber: "+15551234567",
    scheduledAt: new Date(), origin: "manual", triggeredByUserId: 42,
  });
  const q = find("INSERT INTO scheduled_calls");
  assert.match(q.sql, /origin, triggered_by_user_id, triggered_by_name/);
  assert.match(q.sql, /FROM users u WHERE u\.id = \$28::int/,
    "the name is snapshotted — an audit record must not change when a user is renamed");
  assert.equal(q.params[26], "manual");
  assert.equal(q.params[27], 42);
});

test("a scheduler-created call defaults to scheduler with nobody attributed", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ id: 1 }] });
  const scheduledCallsDb = require("../src/db/scheduled-calls");
  await scheduledCallsDb.create({
    companyId: 8, callType: "customer_confirmation", phoneNumber: "+15551234567",
    scheduledAt: new Date(),
  });
  const q = find("INSERT INTO scheduled_calls");
  assert.equal(q.params[26], "scheduler");
  assert.equal(q.params[27], null, "inventing a user for a swept call would be a false audit trail");
});

// ── listForRange — the daily report's read, not a page ─────────────────────

test("listForRange scopes both halves to the SAME window and company, real rows only", async () => {
  reset();
  await logsDb.listForRange(8, { from: "2026-08-13T00:00:00Z", to: "2026-08-14T00:00:00Z" });
  const call = find("FROM calls c");
  const chat = find("FROM chat_links cl");
  assert.match(call.sql, /c\.company_id = \$1 AND c\.is_test = false AND c\.created_at >= \$2 AND c\.created_at < \$3/);
  assert.match(chat.sql, /cl\.company_id = \$1 AND cl\.created_at >= \$2 AND cl\.created_at < \$3/);
  assert.deepEqual(call.params, [8, "2026-08-13T00:00:00Z", "2026-08-14T00:00:00Z"]);
});

test("listForRange with a call_type filters BOTH halves using the SAME bound parameter", async () => {
  reset();
  await logsDb.listForRange(8, { from: "a", to: "b", callType: "customer_confirmation" });
  const call = find("FROM calls c");
  const chat = find("FROM chat_links cl");
  assert.match(call.sql, /sc\.call_type = \$4/);
  assert.match(chat.sql, /cl\.call_type = \$4/);
  assert.deepEqual(call.params, [8, "a", "b", "customer_confirmation"]);
});

test("listForRange with no call_type adds no call_type FILTER to either half", async () => {
  // callSelect always SELECTS call_type into its jsonb blob regardless of any
  // filter — the thing that must be absent is a WHERE condition on it.
  reset();
  await logsDb.listForRange(8, { from: "a", to: "b" });
  assert.ok(!/sc\.call_type\s*=\s*\$/.test(find("FROM calls c").sql));
  assert.ok(!/cl\.call_type\s*=\s*\$/.test(find("FROM chat_links cl").sql));
});

test("listForRange has no OUTER LIMIT/OFFSET — it reads the whole window, not a page", async () => {
  // chatSelect's own one-dispatch-per-link lateral pick legitimately contains
  // "LIMIT 1" — what must be absent is pagination on the OUTER merged select.
  reset();
  await logsDb.listForRange(8, { from: "a", to: "b" });
  const merged = queries.find((q) => q.sql.includes("WITH merged AS"));
  const outer = merged.sql.slice(merged.sql.indexOf("SELECT * FROM merged"));
  assert.ok(!/LIMIT|OFFSET/.test(outer));
});

test("listForRange orders by timestamp — oldest first, matching the business-day narrative", async () => {
  reset();
  await logsDb.listForRange(8, { from: "a", to: "b" });
  const merged = queries.find((q) => q.sql.includes("WITH merged AS"));
  assert.match(merged.sql, /ORDER BY timestamp\s*$/);
});

test("listForRange reuses the SAME callSelect/chatSelect the Logs page itself renders", async () => {
  // Not a re-derivation: the recipient-name fallback chain, the lateral
  // one-dispatch-per-link pick, the cast-safe job join — every trap already
  // fixed in list() must not need fixing twice.
  reset();
  await logsDb.listForRange(8, { from: "a", to: "b" });
  const chat = find("FROM chat_links cl");
  assert.match(chat.sql, /LEFT JOIN LATERAL \(/, "one dispatch per link — the fan-out fix");
  assert.match(chat.sql, /recipientNameFromSendsSQL|SELECT medium, destination/i.test(chat.sql) ? /./ : /COALESCE\(\s*cl\.recipient_name/,
    "the same recipient-name fallback chain as GET /logs");
});
