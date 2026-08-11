/**
 * The shortener's interception guard.
 *
 * This exists because of a real incident. Masking handed TinyURL
 * `https://clara-confirms-backend.vercel.app/c/<code>` and TinyURL monetised
 * it, so a customer tapping their appointment confirmation travelled:
 *
 *   tinyurl.com/<code>
 *     -> tinyurl.com/preview/deprecated/<code>     (interstitial)
 *     -> redirect.viglink.com/?u=<ours>&key=...    (affiliate ad network)
 *     -> our /c/<code>
 *
 * The same shortener pointed at a justclara.ai host returned a clean 301. We
 * cannot control which destinations a shortener decides to monetise, and the
 * original implementation only checked that the response *looked* like a URL —
 * never where that URL went. So the result is now verified.
 *
 * Separate file from sms-link-masking.test.js on purpose: that suite stubs this
 * module out, so it cannot also exercise it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("config", { smsLinkMasking: { enabled: true, provider: "tinyurl" } });

const shortener = require("../src/services/link-shortener");

const realFetch = global.fetch;
test.afterEach(() => { global.fetch = realFetch; });

/** Minimal Response double for a manual-redirect fetch. */
const redirectTo = (location, status = 301) => async () => ({
  ok: true, status, headers: { get: (h) => (h.toLowerCase() === "location" ? location : null) },
});

// ── Accepting a clean link ───────────────────────────────────────────────────

test("a link landing on our URL in one hop is accepted", async () => {
  const target = "https://api.justclara.ai/c/abc1234567";
  global.fetch = redirectTo(target);
  assert.equal(await shortener.resolvesCleanlyTo("https://tinyurl.com/x", target), true);
});

test("a trailing-slash difference is not treated as interception", async () => {
  global.fetch = redirectTo("https://api.justclara.ai/c/abc1234567/");
  assert.equal(
    await shortener.resolvesCleanlyTo("https://tinyurl.com/x", "https://api.justclara.ai/c/abc1234567"),
    true, "shorteners normalise trailing slashes inconsistently — that is not an attack"
  );
});

// ── Refusing anything else ───────────────────────────────────────────────────

test("an affiliate redirect is REFUSED rather than sent to a customer", async () => {
  global.fetch = redirectTo("https://redirect.viglink.com/?u=https%3A%2F%2Fours%2Fc%2Fabc&key=deadbeef", 302);
  assert.equal(await shortener.resolvesCleanlyTo("https://tinyurl.com/x", "https://ours/c/abc"), false,
    "this is the exact shape of the real incident");
});

test("an interstitial hop is REFUSED", async () => {
  global.fetch = redirectTo("https://tinyurl.com/preview/deprecated/x", 302);
  assert.equal(await shortener.resolvesCleanlyTo("https://tinyurl.com/x", "https://ours/c/abc"), false);
});

test("a link that does not redirect at all is REFUSED", async () => {
  global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null } });
  assert.equal(await shortener.resolvesCleanlyTo("https://tinyurl.com/x", "https://ours/c/abc"), false);
});

test("an unverifiable link is REFUSED — cannot verify means cannot trust", async () => {
  global.fetch = async () => { throw new Error("timeout"); };
  assert.equal(await shortener.resolvesCleanlyTo("https://tinyurl.com/x", "https://ours/c/abc"), false);
});

test("refusal is logged loudly, with what it actually resolved to", async () => {
  logger.reset();
  global.fetch = redirectTo("https://redirect.viglink.com/?u=x", 302);
  await shortener.resolvesCleanlyTo("https://tinyurl.com/x", "https://ours/c/abc");
  const warned = logger.records.warn.some(([m]) => /intercepted/i.test(m));
  assert.ok(warned, "a silent refusal would look like the shortener simply being down");
});

// ── shorten() applies the guard ──────────────────────────────────────────────

test("shorten() returns null when its own link is intercepted", async () => {
  const calls = [];
  global.fetch = async (u) => {
    calls.push(String(u));
    if (String(u).includes("api-create.php")) return { ok: true, status: 200, text: async () => "https://tinyurl.com/x" };
    return { ok: true, status: 302, headers: { get: () => "https://redirect.viglink.com/?u=x" } };
  };
  assert.equal(await shortener.shorten("https://api.justclara.ai/c/abc1234567"), null,
    "a monetised link must never reach an SMS body");
  assert.equal(calls.length, 2, "mints, then verifies");
});

test("shorten() returns the link when it resolves cleanly", async () => {
  const target = "https://api.justclara.ai/c/abc1234567";
  global.fetch = async (u) =>
    String(u).includes("api-create.php")
      ? { ok: true, status: 200, text: async () => "https://tinyurl.com/good" }
      : { ok: true, status: 301, headers: { get: () => target } };
  assert.equal(await shortener.shorten(target), "https://tinyurl.com/good");
});

test("a 200 carrying an error string is not mistaken for a link", async () => {
  global.fetch = async () => ({ ok: true, status: 200, text: async () => "Error: invalid url" });
  assert.equal(await shortener.shorten("https://api.justclara.ai/c/abc"), null);
});
