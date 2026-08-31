/**
 * POST /chat-links/:token/footer-click — click tracking for the chat
 * widget's "Powered by Clara AI" footer link (migrations/102). Public,
 * token-authed, best-effort: the frontend's own call is a fire-and-forget
 * fetch(...).catch(() => {}), so a failure here must never surface as
 * anything beyond a logged warning and a non-2xx status.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);

const queries = [];
let queryImpl = async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; };
stub("db", { query: (sql, params) => queryImpl(sql, params) });

let linkRow = { token: "valid-token", company_id: 8 };
stub("db/chat-links", { getByToken: async (token) => (token === linkRow.token ? linkRow : null) });

const router = require("../src/routes/chat-links");

function reset() {
  queries.length = 0;
  queryImpl = async (sql, params) => { queries.push({ sql, params }); return { rows: [], rowCount: 1 }; };
  linkRow = { token: "valid-token", company_id: 8 };
  logger.reset();
}

let server, base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/chat-links", router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/chat-links`;
});
test.after(() => server.close());

async function postFooterClick(token) {
  const res = await fetch(`${base}/${token}/footer-click`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test("a valid token inserts a click row keyed by token and company_id, and returns ok:true", async () => {
  reset();
  const { status, json } = await postFooterClick("valid-token");
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true });
  assert.equal(queries.length, 1);
  assert.match(queries[0].sql, /INSERT INTO chat_footer_link_clicks/);
  assert.deepEqual(queries[0].params, ["valid-token", 8]);
});

test("an unknown token 404s with ok:false and writes nothing", async () => {
  reset();
  const { status, json } = await postFooterClick("bad-token");
  assert.equal(status, 404);
  assert.deepEqual(json, { ok: false });
  assert.equal(queries.length, 0, "a click must never be recorded against a token that doesn't resolve");
});

test("a DB failure on the insert surfaces as a plain 500 ok:false, never throws past the route", async () => {
  reset();
  queryImpl = async () => { throw new Error("connection reset"); };
  const { status, json } = await postFooterClick("valid-token");
  assert.equal(status, 500);
  assert.deepEqual(json, { ok: false });
});

test("OPTIONS preflight is open, same as every other public chat-links route", async () => {
  reset();
  const res = await fetch(`${base}/valid-token/footer-click`, { method: "OPTIONS" });
  assert.ok(res.status < 400);
});
