/**
 * authenticate reads the user's CURRENT role/active/token_version from the DB
 * (migration 115) instead of trusting the token. Without this a demoted or
 * removed colleague kept their old access until the token expired.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

let row;
let lookups = 0;
stub("db", {
  query: async () => { lookups++; return { rows: row ? [row] : [] }; },
});

const config = require("../src/config");
const mw = require("../src/auth/auth.middleware");

const tokenFor = (claims) => jwt.sign({ type: "access", userId: 5, companyId: 7, email: "d@acme.test", role: "admin", ...claims }, config.jwt.secret);

async function run(token) {
  let status = null, body = null, nexted = false;
  const req = { headers: { authorization: `Bearer ${token}` } };
  const res = { status: (s) => { status = s; return { json: (b) => { body = b; } }; } };
  await mw.authenticate(req, res, () => { nexted = true; });
  return { nexted, status, body, user: req.user };
}

test.beforeEach(() => {
  row = { id: 5, company_id: 7, email: "d@acme.test", role: "confirmer", is_active: true, is_deleted: false, is_owner: false, token_version: 3 };
  mw.invalidateUserState();
  lookups = 0;
});

test("the role comes from the database, not the token", async () => {
  const r = await run(tokenFor({ tv: 3, role: "admin" }));
  assert.equal(r.nexted, true);
  assert.equal(r.user.role, "confirmer", "a token minted while they were admin grants only their current role");
});

test("a token from before a token_version bump is rejected", async () => {
  const r = await run(tokenFor({ tv: 2 }));
  assert.equal(r.nexted, false);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, "session_revoked");
});

test("a deactivated or removed user is rejected even with a valid token", async () => {
  row.is_active = false;
  assert.equal((await run(tokenFor({ tv: 3 }))).status, 401);
  mw.invalidateUserState();
  row.is_active = true; row.is_deleted = true;
  assert.equal((await run(tokenFor({ tv: 3 }))).status, 401);
});

test("the state is cached briefly — one lookup for back-to-back requests — and invalidation forces a reread", async () => {
  await run(tokenFor({ tv: 3 }));
  await run(tokenFor({ tv: 3 }));
  assert.equal(lookups, 1);
  mw.invalidateUserState(5);
  await run(tokenFor({ tv: 3 }));
  assert.equal(lookups, 2);
});

test("tokens issued before this release (no tv claim) keep working while token_version is still 0", async () => {
  row.token_version = 0;
  const legacy = jwt.sign({ type: "access", userId: 5, companyId: 7, email: "d@acme.test", role: "admin" }, config.jwt.secret);
  const r = await run(legacy);
  assert.equal(r.nexted, true);
  assert.equal(r.user.role, "confirmer");
});
