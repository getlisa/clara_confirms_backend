/**
 * db/zentrades-credentials.js — the one CRM credentials module that stores
 * a recoverable secret (a password) rather than a cookie or a bare API key,
 * because ZenTrades' 24h JWT has no refresh path (see
 * migrations/107_zentrades_integration.sql's header). Fake db throughout;
 * asserts on the SQL/params actually issued so an encryption bug or a
 * clear-on-failure regression is caught here, not live.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub } = require("./helpers/stub-modules");

process.env.CREDENTIAL_ENCRYPTION_KEY = "b".repeat(64);

const db = createFakeDb();
stub("db", db);

const credentialsDb = require("../src/db/zentrades-credentials");
const realCrypto = require("../src/utils/crypto");

function reset() {
  db.reset();
}

test("upsert encrypts the password before it ever reaches a query param", async () => {
  reset();
  await credentialsDb.upsert(11, "alice@example.com", "hunter2-plaintext");
  const params = db.calls[0].params;
  const storedAuthCode = params[2];
  assert.notEqual(storedAuthCode, "hunter2-plaintext", "the plaintext password must never be bound as a query param");
  assert.match(storedAuthCode, /^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  assert.equal(realCrypto.decrypt(storedAuthCode), "hunter2-plaintext");
});

test("upsert resets auth_status to 'ok' and clears prior failure/token columns — this is the recovery path", async () => {
  reset();
  await credentialsDb.upsert(11, "alice@example.com", "newpassword");
  const sql = db.calls[0].sql;
  assert.match(sql, /auth_status = 'ok'/);
  assert.match(sql, /auth_failed_at = NULL/);
  assert.match(sql, /auth_error = NULL/);
  assert.match(sql, /access_token = NULL/);
  assert.match(sql, /access_token_expires_at = NULL/);
});

test("upsert merges metadata on reconnect rather than clobbering it", async () => {
  reset();
  await credentialsDb.upsert(11, "alice@example.com", "pw", { zentradesCompanyId: 82 });
  const sql = db.calls[0].sql;
  assert.match(sql, /metadata = COALESCE\(zentrades_integration\.metadata, '\{\}'::jsonb\) \|\| COALESCE\(EXCLUDED\.metadata/);
});

test("getByCompanyId never returns the decrypted (or even encrypted) password", async () => {
  reset();
  const encrypted = realCrypto.encrypt("hunter2");
  db.on("FROM zentrades_integration", [{
    username: "alice@example.com", auth_code: encrypted, access_token: "tok",
    access_token_expires_at: "2026-09-09T00:00:00Z", auth_status: "ok",
    auth_failed_at: null, auth_error: null, metadata: { zentradesCompanyId: 82 },
  }]);
  const result = await credentialsDb.getByCompanyId(11);
  assert.equal(result.username, "alice@example.com");
  assert.equal(result.hasPassword, true);
  assert.equal(Object.values(result).includes("hunter2"), false);
  assert.equal(JSON.stringify(result).includes(encrypted), false, "not even the encrypted blob should leak out of getByCompanyId");
});

test("getByCompanyId returns null when no row is active/undeleted/non-empty auth_code", async () => {
  reset();
  const result = await credentialsDb.getByCompanyId(999);
  assert.equal(result, null);
});

test("getCredentialsForLogin decrypts and returns the real password — the ONLY function that does", async () => {
  reset();
  const encrypted = realCrypto.encrypt("hunter2");
  db.on("FROM zentrades_integration", [{ username: "alice@example.com", auth_code: encrypted }]);
  const result = await credentialsDb.getCredentialsForLogin(11);
  assert.deepEqual(result, { username: "alice@example.com", password: "hunter2" });
});

test("getCredentialsForLogin returns null (not a decrypt error) when nothing is stored", async () => {
  reset();
  const result = await credentialsDb.getCredentialsForLogin(999);
  assert.equal(result, null);
});

test("markAuthFailed(invalid_credentials) clears the access token but LEAVES auth_code and username untouched", async () => {
  reset();
  await credentialsDb.markAuthFailed(11, "invalid_credentials", "bad password");
  const sql = db.calls[0].sql;
  const params = db.calls[0].params;
  assert.match(sql, /auth_status = \$2/);
  assert.match(sql, /access_token = NULL/);
  assert.match(sql, /access_token_expires_at = NULL/);
  // The critical negative assertion: this UPDATE must never touch auth_code
  // or username. crm/index.js's resolveSlugForCompany() falls back to
  // "servicetrade" the moment auth_code is empty — clearing it here would
  // silently reclassify a live ZenTrades company as ServiceTrade.
  assert.doesNotMatch(sql, /auth_code\s*=/);
  assert.doesNotMatch(sql, /username\s*=/);
  assert.deepEqual(params, [11, "invalid_credentials", "bad password"]);
});

test("markAuthFailed(forbidden) records the distinct status", async () => {
  reset();
  await credentialsDb.markAuthFailed(11, "forbidden", "role lacks access to /api/ticket");
  assert.deepEqual(db.calls[0].params, [11, "forbidden", "role lacks access to /api/ticket"]);
});

test("markAuthFailed truncates an overlong error message", async () => {
  reset();
  const huge = "x".repeat(5000);
  await credentialsDb.markAuthFailed(11, "invalid_credentials", huge);
  assert.equal(db.calls[0].params[2].length, 2000);
});

test("setAccessToken updates only the token/expiry columns", async () => {
  reset();
  const expires = new Date("2026-09-09T14:26:29Z");
  await credentialsDb.setAccessToken(11, "jwt-value", expires);
  assert.deepEqual(db.calls[0].params, [11, "jwt-value", expires]);
  assert.match(db.calls[0].sql, /access_token = \$2, access_token_expires_at = \$3/);
});

test("clearCredentials wipes the password and token but the row stays discoverable via is_active semantics matching InspectPoint's convention", async () => {
  reset();
  await credentialsDb.clearCredentials(11);
  const sql = db.calls[0].sql;
  assert.match(sql, /auth_code = NULL/);
  assert.match(sql, /access_token = NULL/);
  assert.match(sql, /is_active = FALSE/);
  assert.doesNotMatch(sql, /username\s*=/, "username is preserved for a one-click reconnect, same as InspectPoint's subdomain");
});

test("hasCredentials reflects the same active/non-deleted/non-empty gate as getByCompanyId", async () => {
  reset();
  db.on("FROM zentrades_integration", [{ x: 1 }]);
  assert.equal(await credentialsDb.hasCredentials(11), true);

  reset();
  assert.equal(await credentialsDb.hasCredentials(999), false);
});
