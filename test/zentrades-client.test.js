/**
 * services/zentrades.js — login, token lifecycle, and the authenticated
 * request/fetchAllPages wrapper. Fake credentials/todos DBs + mocked global
 * fetch throughout, so nothing here touches a real network or Postgres.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub } = require("./helpers/stub-modules");

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** A real-shaped (but fake-signed) JWT — only the payload is ever read. */
function makeJwt(payload) {
  return `header.${b64url(payload)}.signature`;
}

function fakeCredentialsDb() {
  const rows = new Map(); // companyId(string) -> row
  const calls = { setAccessToken: [], markAuthFailed: [] };
  return {
    _seed(companyId, row) { rows.set(String(companyId), { authStatus: "ok", ...row }); },
    _calls: calls,
    async getByCompanyId(companyId) {
      const row = rows.get(String(companyId));
      if (!row) return null;
      return {
        username: row.username, hasPassword: true,
        accessToken: row.accessToken ?? null,
        accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
        authStatus: row.authStatus, authFailedAt: null, authError: null, metadata: row.metadata ?? {},
      };
    },
    async getCredentialsForLogin(companyId) {
      const row = rows.get(String(companyId));
      if (!row) return null;
      return { username: row.username, password: row.password };
    },
    async setAccessToken(companyId, accessToken, expiresAt) {
      calls.setAccessToken.push({ companyId, accessToken, expiresAt });
      const row = rows.get(String(companyId));
      if (row) { row.accessToken = accessToken; row.accessTokenExpiresAt = expiresAt; }
    },
    async markAuthFailed(companyId, status, error) {
      calls.markAuthFailed.push({ companyId, status, error });
      const row = rows.get(String(companyId));
      if (row) row.authStatus = status;
    },
  };
}

function fakeTodosDb() {
  const created = [];
  const apiErrors = [];
  return {
    createCrmReauthTodo: async (args) => { created.push(args); return { id: created.length }; },
    createCrmApiErrorTodo: async (args) => { apiErrors.push(args); return { id: apiErrors.length }; },
    _created: created,
    _apiErrors: apiErrors,
  };
}

const credentialsDb = fakeCredentialsDb();
const todosDb = fakeTodosDb();
stub("db/zentrades-credentials", credentialsDb);
stub("db/todos", todosDb);

const zentrades = require("../src/services/zentrades");

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
  };
}

// ── login() ──────────────────────────────────────────────────────────────

test("login() extracts the token and pulls companyId/userId/timezone from the response body's user object", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  const iat = exp - 86400;
  const token = makeJwt({ userId: 689, companyId: 82, iat, exp });
  global.fetch = async () => jsonResponse(200, {
    status: "success",
    result: { "access-token": token, user: { id: 689, company: { id: 82, timezoneRegionName: "America/Toronto" } } },
  });

  const result = await zentrades.login("alice@example.com", "pw");
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, token);
  assert.equal(result.zentradesCompanyId, 82);
  assert.equal(result.zentradesUserId, 689);
  assert.equal(result.timezoneRegionName, "America/Toronto");
});

test("login() ALWAYS sets a fixed 30-day expiry, ignoring the token's own (much shorter) exp claim — there is no refresh endpoint", async () => {
  const shortExp = Math.floor(Date.now() / 1000) + 3600; // the token itself claims only 1h
  global.fetch = async () => jsonResponse(200, { status: "success", result: { "access-token": makeJwt({ exp: shortExp }), user: {} } });
  const result = await zentrades.login("alice", "pw");
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const delta = result.expiresAt.getTime() - Date.now();
  assert.ok(Math.abs(delta - THIRTY_DAYS_MS) < 5000, `expected ~30 days out, got ${delta}ms`);
  assert.notEqual(result.expiresAt.getTime(), shortExp * 1000, "must NOT use the token's own short-lived exp claim");
});

test("login() always sends rememberMe: true, per product decision", async () => {
  let sentBody = null;
  global.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    const exp = Math.floor(Date.now() / 1000) + 86400;
    return jsonResponse(200, { status: "success", result: { "access-token": makeJwt({ exp }), user: {} } });
  };
  await zentrades.login("alice", "pw");
  assert.equal(sentBody.rememberMe, true);
});

test("login() 401 is reported as reason 'invalid_credentials', not a generic error", async () => {
  global.fetch = async () => jsonResponse(401, { message: "Invalid username or password" });
  const result = await zentrades.login("alice", "wrongpw");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid_credentials");
  assert.equal(result.status, 401);
});

test("login() 403 is ALSO 'invalid_credentials' — there is no token yet to be forbidden with", async () => {
  global.fetch = async () => jsonResponse(403, { message: "forbidden" });
  const result = await zentrades.login("alice", "pw");
  assert.equal(result.reason, "invalid_credentials");
});

test("login() with a 200 but no access-token in the body is a shape error, not silently accepted", async () => {
  global.fetch = async () => jsonResponse(200, { status: "success", result: {} });
  const result = await zentrades.login("alice", "pw");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "error");
});

test("login() succeeds even when the token has no exp claim at all — we never rely on it", async () => {
  global.fetch = async () => jsonResponse(200, { status: "success", result: { "access-token": makeJwt({ userId: 1 }) } });
  const result = await zentrades.login("alice", "pw");
  assert.equal(result.ok, true);
  assert.ok(result.expiresAt instanceof Date);
});

test("login() succeeds even when the access token doesn't decode as a JWT at all — it's still a usable opaque bearer credential", async () => {
  global.fetch = async () => jsonResponse(200, { status: "success", result: { "access-token": "not-a-jwt-just-an-opaque-string", user: { id: 1, company: { id: 2 } } } });
  const result = await zentrades.login("alice", "pw");
  assert.equal(result.ok, true);
  assert.equal(result.accessToken, "not-a-jwt-just-an-opaque-string");
  // companyId/userId still come through fine since they're read from the
  // response body's `user` object first, not the undecodable token.
  assert.equal(result.zentradesCompanyId, 2);
  assert.equal(result.zentradesUserId, 1);
});

test("login() surfaces a network failure as reason 'error', not a thrown exception", async () => {
  global.fetch = async () => { throw new Error("ECONNRESET"); };
  const result = await zentrades.login("alice", "pw");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "error");
});

// ── verifyCredentials() ──────────────────────────────────────────────────

test("verifyCredentials() surfaces the metadata a connect route needs to persist", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  global.fetch = async () => jsonResponse(200, {
    status: "success",
    result: { "access-token": makeJwt({ exp }), user: { id: 5, company: { id: 9, timezoneRegionName: "America/Denver" } } },
  });
  const result = await zentrades.verifyCredentials("alice", "pw");
  assert.equal(result.ok, true);
  assert.deepEqual(result.metadata, { zentradesCompanyId: 9, zentradesUserId: 5, timezoneRegionName: "America/Denver" });
});

test("verifyCredentials() on bad credentials returns ok:false with a message, never throws", async () => {
  global.fetch = async () => jsonResponse(401, { message: "nope" });
  const result = await zentrades.verifyCredentials("alice", "wrong");
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, "string");
});

// ── getAccessToken() lifecycle ───────────────────────────────────────────

test("getAccessToken uses the DB-cached token and issues zero login calls when it's well within its window", async () => {
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error("should not be called"); };
  const farFuture = new Date(Date.now() + 60 * 60 * 1000); // 1h out, well past the 5min skew
  credentialsDb._seed(101, { username: "alice", password: "pw", accessToken: "cached-token", accessTokenExpiresAt: farFuture });

  const token = await zentrades.getAccessToken(101);
  assert.equal(token, "cached-token");
  assert.equal(fetchCalls, 0);
});

test("getAccessToken refreshes when the DB token is within the skew window of expiry", async () => {
  const soon = new Date(Date.now() + 60 * 1000); // 1 minute out — inside the 5min skew
  credentialsDb._seed(102, { username: "bob", password: "pw", accessToken: "stale-token", accessTokenExpiresAt: soon });

  const newExp = Math.floor(Date.now() / 1000) + 86400;
  const newToken = makeJwt({ exp: newExp });
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return jsonResponse(200, { status: "success", result: { "access-token": newToken, user: {} } }); };

  const token = await zentrades.getAccessToken(102);
  assert.equal(token, newToken);
  assert.equal(fetchCalls, 1);
  assert.equal(credentialsDb._calls.setAccessToken.at(-1).accessToken, newToken);
});

test("getAccessToken skips login entirely while auth_status is not 'ok' — never hammers a known-bad password", async () => {
  credentialsDb._seed(103, { username: "carol", password: "wrongpw", authStatus: "invalid_credentials" });
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; return jsonResponse(401, { message: "nope" }); };

  const token = await zentrades.getAccessToken(103);
  assert.equal(token, null);
  assert.equal(fetchCalls, 0, "must not attempt a login while locked out");
});

test("getAccessToken returns null for a company with no stored credentials at all", async () => {
  const token = await zentrades.getAccessToken(9999);
  assert.equal(token, null);
});

test("a failed refresh marks auth_status and files a reauth todo exactly once", async () => {
  const soon = new Date(Date.now() + 1000);
  credentialsDb._seed(104, { username: "dave", password: "rotatedpw", accessToken: "old", accessTokenExpiresAt: soon });
  todosDb._created.length = 0;
  global.fetch = async () => jsonResponse(401, { message: "Invalid username or password" });

  const token = await zentrades.getAccessToken(104);
  assert.equal(token, null);
  assert.equal(credentialsDb._calls.markAuthFailed.at(-1).status, "invalid_credentials");
  assert.equal(todosDb._created.length, 1);
  assert.equal(todosDb._created[0].source, "zentrades");
  assert.equal(todosDb._created[0].reason, "invalid_credentials");
});

// ── request() ────────────────────────────────────────────────────────────

test("request() attaches the access token and returns the unwrapped {status,result} envelope", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(201, { username: "erin", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  let seenHeaders = null;
  global.fetch = async (url, opts) => {
    seenHeaders = opts.headers;
    return jsonResponse(200, { status: "success", result: { id: 1924543 } });
  };
  const result = await zentrades.request(201, "GET", "/api/ticket", { query: { id: 1924543 } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { id: 1924543 });
  // "access-token" is the one VERIFIED LIVE to actually work — the server
  // 401s "Access token missing" on Authorization: Bearer alone. That's kept
  // too, at zero cost, in case some other endpoint reads it instead.
  assert.equal(seenHeaders["access-token"], seenHeaders.Authorization.replace(/^Bearer /, ""));
  assert.match(seenHeaders.Authorization, /^Bearer /);
});

test("request() attaches company-id/user-id headers from the connected account's stored identity — VERIFIED LIVE these are required alongside the token", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(212, {
    username: "id-test", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000),
    metadata: { zentradesCompanyId: 3, zentradesUserId: 689 },
  });
  let seenHeaders = null;
  global.fetch = async (url, opts) => { seenHeaders = opts.headers; return jsonResponse(200, { status: "success", result: {} }); };
  await zentrades.request(212, "GET", "/api/ticket");
  assert.equal(seenHeaders["company-id"], "3");
  assert.equal(seenHeaders["user-id"], "689");
});

test("request() omits company-id/user-id headers rather than sending the literal string 'null' when identity isn't known", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(213, { username: "no-identity", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000), metadata: {} });
  let seenHeaders = null;
  global.fetch = async (url, opts) => { seenHeaders = opts.headers; return jsonResponse(200, { status: "success", result: {} }); };
  await zentrades.request(213, "GET", "/api/ticket");
  assert.equal("company-id" in seenHeaders, false);
  assert.equal("user-id" in seenHeaders, false);
});

test("a fresh login also populates company-id/user-id for the SAME request that triggered it", async () => {
  credentialsDb._seed(214, { username: "fresh", password: "pw" }); // no cached token at all — forces refreshAccessToken
  let seenHeaders = null;
  global.fetch = async (url, opts) => {
    if (url.includes("/auth/login")) {
      return jsonResponse(200, {
        status: "success",
        result: { "access-token": makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }), user: { id: 42, company: { id: 7 } } },
      });
    }
    seenHeaders = opts.headers;
    return jsonResponse(200, { status: "success", result: {} });
  };
  await zentrades.request(214, "GET", "/api/ticket");
  assert.equal(seenHeaders["company-id"], "7");
  assert.equal(seenHeaders["user-id"], "42");
});

test("request() always adds a timestamp=<unix ms> query param — VERIFIED LIVE on a real captured request", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(215, { username: "ts", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  let seenUrl = null;
  const before = Date.now();
  global.fetch = async (url) => { seenUrl = url; return jsonResponse(200, { status: "success", result: {} }); };
  await zentrades.request(215, "GET", "/api/ticket");
  const after = Date.now();
  const ts = Number(new URL(seenUrl).searchParams.get("timestamp"));
  assert.ok(ts >= before && ts <= after, `expected timestamp between ${before} and ${after}, got ${ts}`);
});

test("request() unwraps a bare envelope ({requestId,count,hits}) as-is — no `result` key to unwrap", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(202, { username: "f", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  global.fetch = async () => jsonResponse(200, { requestId: null, count: 1, hits: [{ id: 1 }] });
  const result = await zentrades.request(202, "POST", "/api/ticket/search/filtered", { body: {} });
  assert.deepEqual(result.data, { requestId: null, count: 1, hits: [{ id: 1 }] });
});

test("request() on a 401 forces exactly one fresh login and replays — never loops", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(203, { username: "g", password: "pw", accessToken: "expired-early", accessTokenExpiresAt: new Date(exp * 1000) });
  let calls = 0;
  global.fetch = async (url, opts) => {
    calls++;
    if (opts.method === "POST" && url.includes("/auth/login")) {
      return jsonResponse(200, { status: "success", result: { "access-token": makeJwt({ exp }), user: {} } });
    }
    if (calls === 1) return jsonResponse(401, { message: "token expired" }); // first data call with the stale cached token
    return jsonResponse(200, { status: "success", result: { ok: true } });   // second data call, post-refresh
  };
  const result = await zentrades.request(203, "GET", "/api/ticket");
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(calls, 3, "data call (401) + login + data call again = 3 fetches");
});

test("request() gives up after ONE 401-refresh cycle rather than looping forever on a persistently-bad token", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(204, { username: "h", password: "pw", accessToken: "always-401", accessTokenExpiresAt: new Date(exp * 1000) });
  let dataCallCount = 0;
  global.fetch = async (url, opts) => {
    if (url.includes("/auth/login")) {
      return jsonResponse(200, { status: "success", result: { "access-token": makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 }), user: {} } });
    }
    dataCallCount++;
    return jsonResponse(401, { message: "still unauthorized" });
  };
  const result = await zentrades.request(204, "GET", "/api/ticket");
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(dataCallCount, 2, "the original attempt plus exactly one post-refresh retry, then stop");
});

test("request() on a 403 from a valid token marks 'forbidden' (not 'invalid_credentials') and files a todo naming the endpoint", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(205, { username: "i", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  todosDb._created.length = 0;
  global.fetch = async () => jsonResponse(403, { message: "role lacks access" });

  const result = await zentrades.request(205, "GET", "/api/ticket/some-restricted-thing");
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(credentialsDb._calls.markAuthFailed.at(-1).status, "forbidden");
  assert.equal(todosDb._created.at(-1).reason, "forbidden");
  assert.match(todosDb._created.at(-1).error, /some-restricted-thing/);
});

test("request() retries a 429 honoring Retry-After, then succeeds", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(206, { username: "j", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls === 1) return jsonResponse(429, {}, { "retry-after": "0" });
    return jsonResponse(200, { status: "success", result: { ok: true } });
  };
  const result = await zentrades.request(206, "GET", "/api/ticket", { retryable: true });
  assert.equal(result.ok, true);
  assert.equal(calls, 2);
});

test("request() does NOT retry a 5xx when retryable is false (the write-back safety default for POST)", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(207, { username: "k", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  let calls = 0;
  global.fetch = async () => { calls++; return jsonResponse(500, { message: "boom" }); };
  const result = await zentrades.request(207, "POST", "/api/ticket/search/filtered", { body: {}, retryable: false });
  assert.equal(result.ok, false);
  assert.equal(calls, 1, "no retry — a mutating call must not be blindly replayed");
});

test("request() returns ok:false without ever calling fetch when there is no way to authenticate", async () => {
  let fetchCalls = 0;
  global.fetch = async () => { fetchCalls++; throw new Error("should not be reached"); };
  const result = await zentrades.request(99999, "GET", "/api/ticket");
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(fetchCalls, 0);
});

// ── generic API-error monitoring ("any ZenTrades error must reach the UI") ──

test("a definitive non-2xx (not 401/403) files a generic api-error todo naming the endpoint and status", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(208, { username: "z", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  todosDb._apiErrors.length = 0;
  global.fetch = async () => jsonResponse(404, { message: "ticket not found" });
  const result = await zentrades.request(208, "GET", "/api/ticket/some-path", { retryable: false });
  assert.equal(result.ok, false);
  assert.equal(todosDb._apiErrors.length, 1);
  assert.equal(todosDb._apiErrors[0].source, "zentrades");
  assert.equal(todosDb._apiErrors[0].method, "GET");
  assert.equal(todosDb._apiErrors[0].path, "/api/ticket/some-path");
  assert.equal(todosDb._apiErrors[0].status, 404);
  assert.match(todosDb._apiErrors[0].error, /ticket not found/);
});

test("a network failure that exhausts retries files a generic api-error todo with status 0", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(209, { username: "y", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  todosDb._apiErrors.length = 0;
  global.fetch = async () => { throw new Error("ECONNRESET"); };
  const result = await zentrades.request(209, "GET", "/api/ticket", { retryable: false });
  assert.equal(result.ok, false);
  assert.equal(todosDb._apiErrors.length, 1);
  assert.equal(todosDb._apiErrors[0].status, 0);
  assert.match(todosDb._apiErrors[0].error, /ECONNRESET/);
});

test("a successful response never files a generic api-error todo", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(210, { username: "x", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  todosDb._apiErrors.length = 0;
  global.fetch = async () => jsonResponse(200, { status: "success", result: { ok: true } });
  await zentrades.request(210, "GET", "/api/ticket");
  assert.equal(todosDb._apiErrors.length, 0);
});

test("a 403 raises ONLY the forbidden reauth todo, not also a duplicate generic api-error todo", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(211, { username: "w", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  todosDb._created.length = 0;
  todosDb._apiErrors.length = 0;
  global.fetch = async () => jsonResponse(403, { message: "role lacks access" });
  await zentrades.request(211, "GET", "/api/ticket/restricted");
  assert.equal(todosDb._created.length, 1, "the specific forbidden todo");
  assert.equal(todosDb._apiErrors.length, 0, "must not ALSO raise the generic one for the same failure");
});

// ── fetchAllPages() ──────────────────────────────────────────────────────

test("fetchAllPages terminates on an empty page and reports complete:true with the envelope's count", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(301, { username: "l", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  let page = 0;
  global.fetch = async (url) => {
    page++;
    const u = new URL(url);
    assert.equal(u.searchParams.get("page"), String(page));
    if (page <= 2) return jsonResponse(200, { count: 3, hits: [{ id: page }] });
    return jsonResponse(200, { count: 3, hits: [] });
  };
  const result = await zentrades.fetchAllPages(301, "/api/ticket/search/filtered", { terms: [] });
  assert.equal(result.complete, true);
  assert.equal(result.count, 3);
  assert.deepEqual(result.rows.map((r) => r.id), [1, 2]);
});

test("fetchAllPages never terminates on hits.length < size — only on a genuinely empty page", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(302, { username: "m", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  let page = 0;
  global.fetch = async () => {
    page++;
    // First page returns fewer than a full page's worth, but is NOT empty —
    // this must not be treated as "last page" (see services/inspectpoint.js's
    // documented reasoning for why a server that clamps `size` would
    // otherwise make us silently stop after page one).
    if (page === 1) return jsonResponse(200, { count: 5, hits: [{ id: 1 }] });
    if (page === 2) return jsonResponse(200, { count: 5, hits: [] });
    throw new Error("should not fetch a third page");
  };
  const result = await zentrades.fetchAllPages(302, "/api/ticket/search/filtered", {}, { pageSize: 200 });
  assert.equal(page, 2);
  assert.equal(result.rows.length, 1);
});

test("fetchAllPages never sends a sortBy param — the live API rejects it outright with a validation error (E100)", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(303, { username: "n", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  let seenUrl = null;
  global.fetch = async (url) => { seenUrl = url; return jsonResponse(200, { count: 0, hits: [] }); };
  await zentrades.fetchAllPages(303, "/api/ticket/search/filtered", {});
  const u = new URL(seenUrl);
  assert.equal(u.searchParams.has("sortBy[]"), false);
  assert.deepEqual(new Set(u.searchParams.keys()), new Set(["page", "size", "timestamp"]));
});

test("fetchAllPages marks incomplete when a page fails outright", async () => {
  const exp = Math.floor(Date.now() / 1000) + 86400;
  credentialsDb._seed(304, { username: "o", password: "pw", accessToken: makeJwt({ exp }), accessTokenExpiresAt: new Date(exp * 1000) });
  global.fetch = async () => jsonResponse(500, { message: "boom" });
  const result = await zentrades.fetchAllPages(304, "/api/ticket/search/filtered", {}, { retryable: false });
  assert.equal(result.complete, false);
});
