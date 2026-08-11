/**
 * GET /c/:code — the redirect behind a masked SMS link.
 *
 * This is the customer's entry point: if it misbehaves, the SMS delivered
 * fine and the link still goes nowhere. Driven against a real Express app on
 * an ephemeral port with a fake db, so the routing, status codes and Location
 * header are exercised rather than mocked.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
stub("db", db);
stub("utils/logger", silentLogger());
stub("config", { frontendUrl: "https://confirms.justclara.ai" });

const shortLinks = require("../src/routes/short-links");

const TOKEN = "b".repeat(48);
const app = express();
app.use("/c", shortLinks);

let server, base;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server?.close());

/** Follow nothing — the redirect itself is what's under test. */
const get = (path) => fetch(`${base}${path}`, { redirect: "manual" });

const row = (over = {}) => ({
  id: 5, company_id: 9, token: TOKEN, short_code: "abc1234567", expires_at: null, ...over,
});

test("a live code 302s to the real chat URL", async () => {
  db.reset();
  db.on("FROM chat_links WHERE short_code", [row()]);
  const res = await get("/c/abc1234567");
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `https://confirms.justclara.ai/chat/${TOKEN}`);
});

test("302, not 301 — the link expires in 24h and must not be cached", async () => {
  db.reset();
  db.on("FROM chat_links WHERE short_code", [row()]);
  const res = await get("/c/abc1234567");
  assert.notEqual(res.status, 301, "a permanent redirect would be cached by the handset and by proxies");
});

test("an expired link still redirects, with a marker for the expired screen", async () => {
  db.reset();
  db.on("FROM chat_links WHERE short_code", [row({ expires_at: new Date(Date.now() - 1000).toISOString() })]);
  const res = await get("/c/abc1234567");
  assert.equal(res.status, 302);
  const loc = res.headers.get("location");
  assert.match(loc, /\?expired=1$/, "the app shows a real 'expired' screen; a bare 404 would just look broken");
  assert.ok(loc.includes(TOKEN));
});

test("a link expiring in the future is NOT treated as expired", async () => {
  db.reset();
  db.on("FROM chat_links WHERE short_code", [row({ expires_at: new Date(Date.now() + 60_000).toISOString() })]);
  const res = await get("/c/abc1234567");
  assert.ok(!res.headers.get("location").includes("expired"));
});

test("an unknown code is 404, not a redirect", async () => {
  db.reset();
  db.on("FROM chat_links WHERE short_code", []);
  const res = await get("/c/doesnotexist");
  assert.equal(res.status, 404, "bouncing probes into the app would make them indistinguishable from real traffic");
});

test("the code is looked up as a parameter, not interpolated", async () => {
  db.reset();
  db.on("FROM chat_links WHERE short_code", []);
  await get("/c/" + encodeURIComponent("' OR 1=1 --"));
  const call = db.calls.find((c) => c.sql.includes("short_code"));
  assert.match(call.sql, /short_code = \$1/);
  assert.equal(call.params[0], "' OR 1=1 --", "passed as a bound value, never concatenated");
});

test("a db failure is a 500, not a redirect to nowhere", async () => {
  db.reset();
  db.on("FROM chat_links WHERE short_code", () => { throw new Error("db down"); });
  const res = await get("/c/abc1234567");
  assert.equal(res.status, 500);
});

test("the token is URL-encoded into the Location header", async () => {
  db.reset();
  db.on("FROM chat_links WHERE short_code", [row({ token: "tok en/with?chars" })]);
  const res = await get("/c/abc1234567");
  const loc = res.headers.get("location");
  assert.ok(!loc.includes("tok en"), "an unencoded token would truncate or corrupt the target URL");
  assert.match(loc, /tok%20en%2Fwith%3Fchars/);
});
