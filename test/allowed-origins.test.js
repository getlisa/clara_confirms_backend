/**
 * CORS allow-list resolution.
 *
 * The bug this exists for: `ALLOWED_ORIGINS=*` blocked every browser request.
 * The value is comma-split into an array, and the `cors` package only wildcards
 * on the BARE STRING "*" — given `["*"]` it looks for an origin literally named
 * "*", which nothing sends. Preflight answered 204 with no
 * Access-Control-Allow-Origin at all, which the browser reports as
 * "No 'Access-Control-Allow-Origin' header is present on the requested resource".
 *
 * Setting the env var also DISABLES the built-in localhost fallbacks, so a
 * value that looks maximally permissive was in fact maximally restrictive.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveAllowedOrigins, normalize } = require("../src/utils/allowed-origins");

const FALLBACKS = ["http://localhost:8080", "http://localhost:8083", "https://confirms.justclara.ai"];

test('"*" resolves to reflect-any, never the literal string or a one-item list', () => {
  // `true` and not "*": the app sends credentials, and browsers reject
  // `Access-Control-Allow-Origin: *` on a credentialed request.
  assert.equal(resolveAllowedOrigins("*", FALLBACKS), true);
  assert.notDeepEqual(resolveAllowedOrigins("*", FALLBACKS), ["*"]);
  assert.notEqual(resolveAllowedOrigins("*", FALLBACKS), "*");
});

test('"*" anywhere in a list still means no restriction', () => {
  assert.equal(resolveAllowedOrigins("http://localhost:8083,*", FALLBACKS), true);
  assert.equal(resolveAllowedOrigins(" * , https://x.test ", FALLBACKS), true);
});

test("an unset value falls back to the built-in list", () => {
  assert.deepEqual(resolveAllowedOrigins(undefined, FALLBACKS), FALLBACKS);
  assert.deepEqual(resolveAllowedOrigins("", FALLBACKS), FALLBACKS);
});

test("an explicit list is honoured exactly — and does NOT gain the fallbacks", () => {
  // This is the trap that caused the outage: setting the var at all replaces
  // the localhost defaults, so anything not listed is blocked.
  const out = resolveAllowedOrigins("https://app.example.com", FALLBACKS);
  assert.deepEqual(out, ["https://app.example.com"]);
  assert.ok(!out.includes("http://localhost:8083"));
});

test("trailing slashes and case are normalized away", () => {
  // An Origin header is always lowercase scheme+host with no trailing slash,
  // but FRONTEND_URL is written as "https://confirms.justclara.ai/" — that entry
  // would never match, failing identically to not being listed.
  assert.deepEqual(resolveAllowedOrigins("https://Confirms.JustClara.ai/", FALLBACKS),
    ["https://confirms.justclara.ai"]);
  assert.equal(normalize("https://x.test///"), "https://x.test");
});

test("blank entries from a trailing comma are dropped, not turned into ''", () => {
  // "" would otherwise sit in the list and match a missing Origin header.
  assert.deepEqual(resolveAllowedOrigins("http://a.test,,http://b.test,", FALLBACKS),
    ["http://a.test", "http://b.test"]);
});

test("duplicates collapse", () => {
  assert.deepEqual(resolveAllowedOrigins("http://a.test,http://A.test/", FALLBACKS), ["http://a.test"]);
});

test("a list of only blanks falls back rather than blocking everything", () => {
  assert.deepEqual(resolveAllowedOrigins(",,  ,", FALLBACKS), FALLBACKS);
});
