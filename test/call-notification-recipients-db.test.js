/**
 * db/call-notification-recipients.js — CRUD, the enqueue path's read, and the
 * event-key validation.
 *
 * The event array is the part worth guarding: a typo'd key stored silently
 * would leave someone subscribed to nothing while the UI showed the row as
 * saved, which is indistinguishable from the feature being broken.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const queries = [];
let queryImpl = async () => ({ rows: [] });
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

const recipients = require("../src/db/call-notification-recipients");

function reset() { queries.length = 0; queryImpl = async () => ({ rows: [] }); }
const find = (frag) => queries.find((q) => q.sql.includes(frag));

const ROW = {
  id: 1, company_id: 8, email: "erica@ufp.test", name: "Erica",
  events: ["confirmed"], enabled: false,
};

// ── the vocabulary ───────────────────────────────────────────────────────────

test("the event vocabulary matches deriveTodoType's outcomes one-for-one", () => {
  const todosDb = require("../src/db/todos");

  // Every todo type a conversation can produce must have a notification event,
  // or that outcome would be unreachable for a recipient.
  const conversationTodoTypes = [
    todosDb.TODO_TYPES.VOICEMAIL,
    todosDb.TODO_TYPES.NOT_PICKED,
    todosDb.TODO_TYPES.ASKED_FOR_RESCHEDULE,
    todosDb.TODO_TYPES.ASKED_FOR_CANCELLATION,
    todosDb.TODO_TYPES.APPOINTMENT_NEEDED,
    todosDb.TODO_TYPES.UNCONFIRMED,
  ];
  // 6 outcome types + the null (confirmed) case.
  assert.equal(recipients.EVENT_KEYS.length, conversationTodoTypes.length + 1);
  assert.ok(recipients.EVENT_KEYS.includes("confirmed"), "the happy path is subscribable");
});

test("every event carries a label and a description for the settings UI", () => {
  for (const e of recipients.EVENTS) {
    assert.ok(e.key && e.label && e.description, `${e.key} is fully described`);
    assert.ok(recipients.EVENT_KEYS.includes(e.key));
  }
});

// ── event normalisation ──────────────────────────────────────────────────────

test("unknown event keys are rejected, never silently dropped", () => {
  assert.throws(
    () => recipients.normalizeEvents(["confirmed", "confrimed"]),
    (err) => err.code === "BAD_EVENTS" && /confrimed/.test(err.message)
  );
});

test("events are de-duplicated, case-folded, and stored in canonical order", () => {
  const out = recipients.normalizeEvents(["NOT_PICKED", " confirmed ", "not_picked"]);
  assert.deepEqual(out, ["confirmed", "not_picked"], "canonical order, not input order");
});

test("a non-array events value is rejected", () => {
  assert.throws(() => recipients.normalizeEvents("confirmed"), (err) => err.code === "BAD_EVENTS");
  assert.throws(() => recipients.normalizeEvents(null), (err) => err.code === "BAD_EVENTS");
});

test("an empty array is allowed — it means 'notify me about nothing, for now'", () => {
  assert.deepEqual(recipients.normalizeEvents([]), []);
});

// ── create ───────────────────────────────────────────────────────────────────

test("create forces enabled=false and lowercases the email before it reaches the DB", async () => {
  reset();
  queryImpl = async () => ({ rows: [ROW] });

  const r = await recipients.create({ companyId: 8, email: "Erica@UFP.test", name: "Erica" });

  assert.equal(r.enabled, false);
  const q = find("INSERT INTO call_notification_recipients");
  assert.equal(q.params[1], "erica@ufp.test");
  assert.ok(q.sql.includes("false"), "enabled is a literal false, not a parameter the caller can set");
});

test("create defaults to ALL events when none are given", async () => {
  reset();
  queryImpl = async () => ({ rows: [ROW] });

  await recipients.create({ companyId: 8, email: "ops@ufp.test" });

  const q = find("INSERT INTO call_notification_recipients");
  assert.deepEqual(q.params[3], recipients.ALL_EVENTS);
  assert.equal(q.params[3].length, 7);
});

test("create validates the events it is given", async () => {
  reset();
  await assert.rejects(
    () => recipients.create({ companyId: 8, email: "ops@ufp.test", events: ["nonsense"] }),
    (err) => err.code === "BAD_EVENTS"
  );
  assert.equal(queries.length, 0, "rejected before touching the database");
});

test("a duplicate address surfaces as a DUPLICATE-coded error, not a 500", async () => {
  reset();
  queryImpl = async () => { const e = new Error("dup"); e.code = "23505"; throw e; };
  await assert.rejects(
    () => recipients.create({ companyId: 8, email: "erica@ufp.test" }),
    (err) => err.code === "DUPLICATE"
  );
});

// ── update ───────────────────────────────────────────────────────────────────

test("update touches only the fields given", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ ...ROW, enabled: true }] });

  await recipients.update(8, 1, { enabled: true });

  const q = find("UPDATE call_notification_recipients SET");
  assert.ok(q.sql.includes("enabled = $3"));
  assert.ok(!q.sql.includes("email ="), "an untouched email is not rewritten");
  assert.ok(q.sql.includes("updated_at = now()"));
});

test("update re-lowercases a changed email and validates changed events", async () => {
  reset();
  queryImpl = async () => ({ rows: [ROW] });
  await recipients.update(8, 1, { email: "NEW@UFP.test", events: ["voicemail", "confirmed"] });
  const q = find("UPDATE call_notification_recipients SET");
  assert.equal(q.params[2], "new@ufp.test");
  assert.deepEqual(q.params[3], ["confirmed", "voicemail"]);

  reset();
  await assert.rejects(
    () => recipients.update(8, 1, { events: ["bogus"] }),
    (err) => err.code === "BAD_EVENTS"
  );
});

test("an update with no recognised fields reads instead of writing", async () => {
  reset();
  queryImpl = async () => ({ rows: [ROW] });
  await recipients.update(8, 1, { nope: true });
  assert.equal(find("UPDATE call_notification_recipients SET"), undefined);
  assert.ok(find("SELECT * FROM call_notification_recipients"), "fell through to a read");
});

// ── the enqueue path's read ──────────────────────────────────────────────────

test("listEnabledForEvent filters on enabled AND membership, in SQL", async () => {
  reset();
  queryImpl = async () => ({ rows: [ROW] });

  await recipients.listEnabledForEvent(8, "confirmed");

  const q = find("SELECT * FROM call_notification_recipients");
  assert.ok(q.sql.includes("enabled = true"));
  assert.ok(q.sql.includes("$2 = ANY(events)"), "membership is tested by Postgres, not in JS");
  assert.deepEqual(q.params, [8, "confirmed"]);
});

test("every read and write is scoped to the company", async () => {
  reset();
  queryImpl = async () => ({ rows: [ROW] });

  await recipients.list(8);
  await recipients.getById(8, 1);
  await recipients.listEnabledForEvent(8, "confirmed");
  await recipients.update(8, 1, { enabled: true });
  await recipients.remove(8, 1);

  for (const q of queries) {
    assert.ok(/company_id = \$1/.test(q.sql), `company-scoped: ${q.sql.slice(0, 60)}`);
    assert.equal(q.params[0], 8);
  }
});

test("remove reports whether anything was actually deleted", async () => {
  reset();
  queryImpl = async () => ({ rows: [], rowCount: 0 });
  assert.equal(await recipients.remove(8, 999), false, "so the route can 404");

  reset();
  queryImpl = async () => ({ rows: [], rowCount: 1 });
  assert.equal(await recipients.remove(8, 1), true);
});

// ── the join the email depends on ────────────────────────────────────────────

test("getById joins locations, or the email has no site name to use", () => {
  const fs = require("node:fs");
  const src = fs.readFileSync(require.resolve("../src/db/calls.js"), "utf8");
  const fn = src.slice(src.indexOf("async function getById"));
  const body = fn.slice(0, fn.indexOf("\n}"));

  // This was the bug: only list() had the jobs -> locations hop, so the
  // notification email (which reads through getById) always saw location_name
  // undefined and fell through to the raw phone number.
  assert.ok(/LEFT JOIN locations l/.test(body), "getById reaches locations");
  assert.ok(/l\.name AS location_name/.test(body), "and selects the name");
  assert.ok(/NULLIF\(regexp_replace/.test(body),
    "via the digits-only cast, since scheduled_calls.job_id can hold non-numeric refs");
});
