/**
 * mintServiceLinkUrl — the customer-facing ServiceTrade job-summary URL.
 * Switched from the company-level `userId=` param to a real `contactId=`
 * (the ServiceTrade contact this conversation is actually with), per a
 * captured request: GET /token?jobId=&contactId=. The old userId method is
 * kept ONLY as a fallback for a caller with no contact to resolve.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());

let requestCalls = [];
let responseImpl = () => ({ ok: true, status: 200, data: { token: "tok-abc" } });
stub("services/servicetrade-api", {
  stLoggedRequest: async (companyId, method, path, opts) => {
    requestCalls.push({ companyId, method, path, opts });
    return responseImpl();
  },
});

let queryImpl = async () => ({ rows: [] });
stub("db", { query: async (...a) => queryImpl(...a) });

const { mintServiceLinkUrl } = require("../src/services/servicetrade-service-link");

function reset() {
  requestCalls = [];
  responseImpl = () => ({ ok: true, status: 200, data: { token: "tok-abc" } });
  queryImpl = async () => ({ rows: [] });
}

test("with a contactExternalRef, mints via contactId= — not userId=", async () => {
  reset();
  const out = await mintServiceLinkUrl(8, "12345", "9988");
  assert.equal(out.ok, true);
  assert.equal(out.url, "https://app.servicetrade.com/customer/jobsummary?id=tok-abc");
  assert.match(requestCalls[0].path, /^\/token\?jobId=12345&contactId=9988$/);
  assert.equal(requestCalls[0].method, "GET");
});

test("with no contactExternalRef, falls back to the company's servicetrade_user_id (userId=)", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ user_id: "77" }] });
  const out = await mintServiceLinkUrl(8, "12345", null);
  assert.equal(out.ok, true);
  assert.match(requestCalls[0].path, /^\/token\?jobId=12345&userId=77$/);
});

test("with no contact AND no stored user id, fails cleanly rather than calling ServiceTrade", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  const out = await mintServiceLinkUrl(8, "12345", null);
  assert.equal(out.ok, false);
  assert.equal(requestCalls.length, 0, "never even calls ServiceTrade with a garbage query");
});

test("a failed token response surfaces the status, not a thrown error", async () => {
  reset();
  responseImpl = () => ({ ok: false, status: 500, data: null });
  const out = await mintServiceLinkUrl(8, "12345", "9988");
  assert.equal(out.ok, false);
  assert.equal(out.status, 500);
});

test("URL-encodes both the job ref and the contact ref", async () => {
  reset();
  await mintServiceLinkUrl(8, "job/with slash", "contact&amp");
  assert.match(requestCalls[0].path, /jobId=job%2Fwith%20slash/);
  assert.match(requestCalls[0].path, /contactId=contact%26amp/);
});
