/**
 * db/todos.js's createCrmReauthTodo/resolveCrmReauthTodos — filed when a CRM
 * integration's stored credentials stop working (see
 * services/zentrades.js's login() for the only caller today). Mirrors
 * createMissingPhone's idempotent-reuse pattern: fake db, asserting on SQL
 * issued so a dedup-key typo is caught here rather than as duplicate todos
 * piling up every 2-hour cron run in production.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub } = require("./helpers/stub-modules");

const db = createFakeDb();
stub("db", db);

const todosDb = require("../src/db/todos");

function reset() {
  db.reset();
  // Default RETURNING * result for the INSERT INTO todos — individual tests
  // override with db.on(...) when they need to inspect/vary the row itself.
  db.on("INSERT INTO todos", [{ id: 1 }]);
}

test("createCrmReauthTodo checks for an existing OPEN todo scoped to (company, source, reason) before inserting", async () => {
  reset();
  await todosDb.createCrmReauthTodo({ companyId: 11, source: "zentrades", reason: "invalid_credentials", error: "bad password" });
  const selectSql = db.calls[0].sql;
  assert.match(selectSql, /type = 'CRM_SYNC' AND status = 'open'/);
  assert.match(selectSql, /metadata->>'source' = \$2/);
  assert.match(selectSql, /metadata->>'reason' = \$3/);
  assert.deepEqual(db.calls[0].params, [11, "zentrades", "invalid_credentials"]);
});

test("a second call with an already-open matching todo does NOT insert a duplicate", async () => {
  reset();
  db.on("SELECT id FROM todos", [{ id: 42 }]);
  const result = await todosDb.createCrmReauthTodo({ companyId: 11, source: "zentrades", reason: "invalid_credentials" });
  assert.deepEqual(result, { id: 42 });
  assert.equal(db.calls.length, 1, "must not issue an INSERT when an open match already exists");
});

test("createCrmReauthTodo inserts with type CRM_SYNC, high priority, and the reason/source/error in metadata", async () => {
  reset();
  await todosDb.createCrmReauthTodo({ companyId: 11, source: "zentrades", reason: "forbidden", error: "role lacks access to /api/ticket" });
  const insertSql = db.calls[1].sql;
  const params = db.calls[1].params;
  assert.match(insertSql, /INSERT INTO todos/);
  assert.match(insertSql, /'CRM_SYNC', 'high', FALSE/);
  const metadata = JSON.parse(params[1]);
  assert.deepEqual(metadata, { source: "zentrades", reason: "forbidden", error: "role lacks access to /api/ticket" });
});

test("createCrmReauthTodo distinguishes invalid_credentials vs forbidden in the human-facing note", async () => {
  reset();
  await todosDb.createCrmReauthTodo({ companyId: 11, source: "zentrades", reason: "invalid_credentials" });
  assert.match(db.calls[1].params[2], /password no longer works/);

  reset();
  await todosDb.createCrmReauthTodo({ companyId: 11, source: "zentrades", reason: "forbidden" });
  assert.match(db.calls[1].params[2], /lacks access/);
});

test("createCrmReauthTodo truncates an overlong error to 2000 chars", async () => {
  reset();
  const huge = "x".repeat(5000);
  await todosDb.createCrmReauthTodo({ companyId: 11, source: "zentrades", reason: "invalid_credentials", error: huge });
  const metadata = JSON.parse(db.calls[1].params[1]);
  assert.equal(metadata.error.length, 2000);
});

test("createCrmReauthTodo logs a todo_logs row on creation", async () => {
  reset();
  await todosDb.createCrmReauthTodo({ companyId: 11, source: "zentrades", reason: "invalid_credentials" });
  assert.match(db.calls[2].sql, /INSERT INTO todo_logs/);
});

test("resolveCrmReauthTodos resolves only OPEN CRM_SYNC todos for that (company, source) with a reauth reason", async () => {
  reset();
  await todosDb.resolveCrmReauthTodos({ companyId: 11, source: "zentrades" });
  const sql = db.calls[0].sql;
  assert.match(sql, /UPDATE todos SET status = 'resolved'/);
  assert.match(sql, /type = 'CRM_SYNC' AND status = 'open'/);
  assert.match(sql, /metadata->>'source' = \$2/);
  assert.match(sql, /metadata->>'reason' IN \('invalid_credentials', 'forbidden'\)/);
  assert.deepEqual(db.calls[0].params, [11, "zentrades"]);
});

test("a different source's reauth todo does not satisfy the dedup check — the SELECT is scoped by source", async () => {
  reset();
  let seenParams = null;
  db.on("SELECT id FROM todos", (params) => { seenParams = params; return []; }); // simulate: no zentrades match, regardless of any servicetrade row
  await todosDb.createCrmReauthTodo({ companyId: 11, source: "zentrades", reason: "invalid_credentials" });
  assert.equal(seenParams[1], "zentrades", "the dedup SELECT must filter on this call's own source, not just company+reason");
});
