/**
 * ServiceTrade connections must never need a human to stay live: when
 * ServiceTrade ends our PHPSESSID session, the backend logs in again from the
 * stored (encrypted) password and retries. Runs services/servicetrade.js for
 * real against a fake ServiceTrade (global fetch).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.CREDENTIAL_ENCRYPTION_KEY = "a".repeat(64);

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

const crypto = require("../src/utils/credential-crypto");

// ── fake credential store ───────────────────────────────────────────────────
let stored;
const calls = { updateSession: [], markAuthError: [] };
stub("db/servicetrade-credentials", {
  getByCompanyId: async () => (stored.authCode ? { username: stored.username, authCode: stored.authCode } : null),
  getPasswordForReauth: async () => (stored.passwordEncrypted ? { username: stored.username, password: crypto.decrypt(stored.passwordEncrypted) } : null),
  updateSession: async (_c, cookie) => { calls.updateSession.push(cookie); stored.authCode = cookie; },
  markAuthError: async (_c, msg) => { calls.markAuthError.push(msg); },
});

// ── fake ServiceTrade ───────────────────────────────────────────────────────
let validSession;
let realPassword;
let logins;
global.fetch = async (url, init = {}) => {
  const cookie = init.headers?.Cookie || "";
  const json = (status, body, headers = {}) => ({
    status, ok: status >= 200 && status < 300,
    json: async () => body,
    headers: { getSetCookie: () => headers.setCookie || [] },
  });
  if (url.endsWith("/auth") && init.method === "POST") {
    logins++;
    const { password } = JSON.parse(init.body);
    if (password !== realPassword) return json(403, { messages: { error: ["bad"] } });
    validSession = `PHPSESSID=fresh${logins}`;
    return json(200, { data: { authenticated: true, authToken: `fresh${logins}`, user: { id: 1 } } }, { setCookie: [`${validSession}; path=/`] });
  }
  if (url.endsWith("/auth")) return cookie === validSession ? json(200, { data: { authenticated: true } }) : json(404, {});
  if (url.includes("/job/missing")) return cookie === validSession ? json(404, { messages: { error: ["Resource not found"] } }) : json(401, {});
  return cookie === validSession ? json(200, { data: { jobs: [] } }) : json(401, {});
};

const st = require("../src/services/servicetrade");

test.beforeEach(() => {
  stored = { username: "ops@acme.test", authCode: "PHPSESSID=old", passwordEncrypted: crypto.encrypt("hunter2") };
  realPassword = "hunter2";
  validSession = "PHPSESSID=somebody-else"; // ServiceTrade has ended our "old" session
  logins = 0;
  calls.updateSession.length = 0;
  calls.markAuthError.length = 0;
});

test("encryption round-trips, and any tampering fails loudly", () => {
  const enc = crypto.encrypt("s3cret!");
  assert.match(enc, /^v1:/);
  assert.ok(!enc.includes("s3cret!"));
  assert.equal(crypto.decrypt(enc), "s3cret!");
  assert.notEqual(crypto.encrypt("s3cret!"), enc, "random IV per value");
  const parts = enc.split(":");
  parts[3] = Buffer.from("tampered").toString("base64");
  assert.throws(() => crypto.decrypt(parts.join(":")));
});

test("an expired session is renewed from the stored password and the request succeeds", async () => {
  const creds = { username: stored.username, authCode: stored.authCode };
  const res = await st.request(7, "GET", "/job", {}, creds);
  assert.equal(res.status, 200);
  assert.equal(logins, 1);
  assert.deepEqual(calls.updateSession, [validSession], "new session persisted for other instances");
  assert.equal(creds.authCode, validSession, "caller's credentials now carry the new session");
  assert.equal(calls.markAuthError.length, 0);
});

test("later requests in the same run reuse the renewed session — one login, not one per request", async () => {
  const creds = { username: stored.username, authCode: stored.authCode };
  for (let i = 0; i < 5; i++) assert.equal((await st.request(7, "GET", "/job", {}, creds)).status, 200);
  assert.equal(logins, 1);
});

test("concurrent requests hitting an expired session share a single re-login", async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => st.request(7, "GET", "/job", {}, { username: stored.username, authCode: "PHPSESSID=old" })));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(logins, 1);
});

test("a session another instance already renewed is reused instead of logging in again", async () => {
  validSession = "PHPSESSID=renewed-elsewhere";
  stored.authCode = validSession;
  const res = await st.request(7, "GET", "/job", {}, { username: stored.username, authCode: "PHPSESSID=old" });
  assert.equal(res.status, 200);
  assert.equal(logins, 0);
});

test("a 404 (missing resource) never triggers a re-login", async () => {
  validSession = "PHPSESSID=old";
  const res = await st.request(7, "GET", "/job/missing", {}, { username: stored.username, authCode: "PHPSESSID=old" });
  assert.equal(res.status, 404);
  assert.equal(logins, 0);
});

test("a changed password is recorded as needing a human, and the 401 is returned", async () => {
  realPassword = "changed-in-servicetrade";
  const res = await st.request(7, "GET", "/job", {}, { username: stored.username, authCode: "PHPSESSID=old" });
  assert.equal(res.status, 401);
  assert.equal(calls.markAuthError.length, 1);
  assert.match(calls.markAuthError[0], /was the password changed/);
});

test("a connection made before auto-renewal (no stored password) says to reconnect once", async () => {
  stored.passwordEncrypted = null;
  const res = await st.request(7, "GET", "/job", {}, { username: stored.username, authCode: "PHPSESSID=old" });
  assert.equal(res.status, 401);
  assert.match(calls.markAuthError[0], /Reconnect ServiceTrade once/);
});

test("keepAlive leaves a live session alone and renews a dead one", async () => {
  validSession = "PHPSESSID=old";
  assert.deepEqual(await st.keepAlive(7), { status: "alive" });
  assert.equal(logins, 0);
  validSession = "PHPSESSID=gone";
  assert.deepEqual(await st.keepAlive(7), { status: "renewed" });
  assert.equal(logins, 1);
});

test("the session cookie is never printed to logs", () => {
  const src = require("node:fs").readFileSync(require.resolve("../src/services/servicetrade.js"), "utf8");
  assert.doesNotMatch(src, /console\.log\(/);
});
