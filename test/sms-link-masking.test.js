/**
 * Masking the confirmation link in SMS.
 *
 * Two properties are load-bearing and easy to regress silently:
 *
 *   Deliverability — a carrier rejected this message with Twilio 30007 purely
 *   because of the domain in the body. The masked link is the fix, and the
 *   fallback must never turn a shortener outage into a lost confirmation.
 *
 *   Segment count — SMS has no markup, and ONE character outside GSM-7 drops
 *   the per-segment limit from 160 to 70. Company and job names are free text
 *   from the CRM, so an em dash in a company name would double the cost of
 *   every message it sends. That is invisible unless asserted.
 *
 * Fake db + stubbed shortener; no network, no Twilio.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
const logger = silentLogger();
stub("db", db);
stub("utils/logger", logger);

const smsSent = [];
stub("utils/sms", { sendSms: async ({ to, body }) => { smsSent.push({ to, body }); return true; } });

let shortenImpl = async () => "https://tinyurl.com/masked01";
const shortenCalls = [];
const monetisedWarnings = [];
stub("services/link-shortener", {
  shorten: async (url) => { shortenCalls.push(url); return shortenImpl(url); },
  // The double must expose the whole surface chat-link-sms imports; a missing
  // export here is an undefined call at runtime, not a helpful error.
  warnIfLikelyMonetisedHost: (host) => { monetisedWarnings.push(host); return false; },
  resolvesCleanlyTo: async () => true,
});

const cfg = {
  frontendUrl: "https://confirms.justclara.ai",
  smsLinkMasking: { enabled: true, provider: "tinyurl", publicApiUrl: "https://api.example.com" },
};
stub("config", cfg);

const chatLinkSms = require("../src/services/chat-link-sms");
const chatLinkEmail = require("../src/services/chat-link-email");

// ── GSM-7 segment maths ──────────────────────────────────────────────────────

const GSM =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡" +
  "ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const EXT = "^{}\\[~]|€";

function segments(s) {
  let units = 0;
  for (const ch of s) {
    if (GSM.includes(ch)) units += 1;
    else if (EXT.includes(ch)) units += 2;
    else return { enc: "UCS-2", segs: [...s].length <= 70 ? 1 : Math.ceil([...s].length / 67) };
  }
  return { enc: "GSM-7", segs: units <= 160 ? 1 : Math.ceil(units / 153) };
}

const TOKEN = "a".repeat(48);
const LINK = { id: 5, token: TOKEN, short_code: null, short_url: null, expires_at: null };

function reset(over = {}) {
  db.reset(); logger.reset();
  smsSent.length = 0; shortenCalls.length = 0;
  shortenImpl = async () => "https://tinyurl.com/masked01";
  cfg.smsLinkMasking = { enabled: true, provider: "tinyurl", publicApiUrl: "https://api.example.com", ...over };
  // Defaults for the two writes the happy path makes. Registered here rather
  // than per-test so a test that forgets one gets working behaviour instead of
  // a silent fallback that looks like the feature is off. `on` is
  // last-registered-wins, so individual tests can still override these.
  db.on("SET short_code", (params) => [{ ...LINK, short_code: params[0] }]);
  db.on("SET short_url", (params) => [{ ...LINK, short_url: params[0] }]);
}

const send = (over = {}) => chatLinkSms.sendConfirmationLinkSms({
  phone: "+15551234567", customerName: "Kay Walton", companyName: "Total Fire & Security",
  jobName: "Inspection Job #49707603", token: TOKEN, link: { ...LINK }, ...over,
});

// ── The point of the exercise ────────────────────────────────────────────────

test("the SMS carries the masked link, never the filtered domain", async () => {
  reset();
  await send();
  assert.equal(smsSent.length, 1);
  assert.match(smsSent[0].body, /https:\/\/tinyurl\.com\/masked01/);
  assert.ok(!smsSent[0].body.includes("confirms.justclara.ai"),
    "the whole reason this exists is that this domain got the message blocked");
});

test("the shortener is handed OUR redirect, never the chat token", async () => {
  reset();
  await send();
  assert.deepEqual(shortenCalls.length, 1);
  assert.match(shortenCalls[0], /^https:\/\/api\.example\.com\/c\/[0-9a-zA-Z]{10}$/);
  assert.ok(!shortenCalls[0].includes(TOKEN),
    "the token is the auth credential for the chat — it must not reach a third party");
});

test("masked body is GSM-7 and fits in ONE segment", async () => {
  reset();
  await send();
  const r = segments(smsSent[0].body);
  assert.equal(r.enc, "GSM-7");
  assert.equal(r.segs, 1, `body was ${smsSent[0].body.length} chars: ${smsSent[0].body}`);
});

test("an em dash in a company name does not silently inflate the segment count", async () => {
  reset();
  await send({ companyName: "Total Fire — Security", customerName: "José’s Facilities" });
  const sanitised = smsSent[0].body;

  assert.match(sanitised, /Total Fire - Security/);
  assert.match(sanitised, /José's Facilities/);

  // The property is "fewer segments than the unsanitised equivalent", NOT
  // "always one segment" — a long enough name spills to two regardless, and
  // asserting 1 here would just be asserting these particular fixture names.
  const unsanitised = sanitised
    .replace("Total Fire - Security", "Total Fire — Security")
    .replace("José's Facilities", "José’s Facilities");

  const before = segments(unsanitised);
  const after = segments(sanitised);
  assert.equal(before.enc, "UCS-2", "one em dash drags the whole message to UCS-2");
  assert.equal(after.enc, "GSM-7");
  assert.ok(after.segs < before.segs,
    `sanitising must cost fewer segments: ${before.segs} -> ${after.segs}`);
});

test("an emoji is dropped rather than promoting the message to UCS-2", async () => {
  reset();
  await send({ jobName: "Fire Inspection 🚒" });
  assert.equal(segments(smsSent[0].body).enc, "GSM-7");
  assert.ok(!smsSent[0].body.includes("🚒"));
});

// ── Fallback: a shortener outage must not cost a confirmation ────────────────

test("shortener returning null → plain URL, message still sent", async () => {
  reset();
  shortenImpl = async () => null;
  await send();
  assert.equal(smsSent.length, 1, "the confirmation must go out regardless");
  assert.match(smsSent[0].body, /confirms\.justclara\.ai\/chat\//);
});

test("shortener throwing → plain URL, message still sent", async () => {
  reset();
  shortenImpl = async () => { throw new Error("network down"); };
  await assert.doesNotReject(() => send());
  assert.equal(smsSent.length, 1);
  assert.match(smsSent[0].body, /confirms\.justclara\.ai\/chat\//);
});

test("masking disabled → exactly today's URL", async () => {
  reset({ enabled: false });
  await send();
  assert.equal(shortenCalls.length, 0, "no third-party call at all when switched off");
  assert.match(smsSent[0].body, /confirms\.justclara\.ai\/chat\/a{48}/);
});

test("PUBLIC_API_URL unset → plain URL rather than a dead /c/ link", async () => {
  reset({ publicApiUrl: "" });
  await send();
  assert.equal(shortenCalls.length, 0);
  assert.match(smsSent[0].body, /confirms\.justclara\.ai\/chat\//);
  assert.ok(logger.records.warn.some(([m]) => /PUBLIC_API_URL/.test(m)), "must be loud, not silent");
});

test("no link row → plain URL", async () => {
  reset();
  db.on("FROM chat_links", []);
  await send({ link: null });
  assert.equal(smsSent.length, 1);
  assert.match(smsSent[0].body, /confirms\.justclara\.ai\/chat\//);
});

// ── Idempotence ──────────────────────────────────────────────────────────────

test("a cached short_url is reused — the shortener is not called again", async () => {
  reset();
  await send({ link: { ...LINK, short_code: "abc1234567", short_url: "https://tinyurl.com/cached" } });
  assert.equal(shortenCalls.length, 0, "a resend or retry must not re-mint a link");
  assert.match(smsSent[0].body, /tinyurl\.com\/cached/);
});

test("an existing short_code is reused rather than minting a second one", async () => {
  reset();
  await send({ link: { ...LINK, short_code: "existing00" } });
  assert.equal(shortenCalls[0], "https://api.example.com/c/existing00");
  assert.equal(db.matched("SET short_code").length, 0, "no second claim attempt");
});

test("losing the claim race uses the winner's code, not a second one", async () => {
  reset();
  db.on("SET short_code", []);                                  // CAS returns nothing = we lost
  db.on("FROM chat_links WHERE token", [{ ...LINK, short_code: "winner0000" }]);
  await send({ link: { ...LINK } });
  assert.equal(shortenCalls[0], "https://api.example.com/c/winner0000",
    "two workers on one link must never create two public entry points to the same chat");
});

test("failing to cache the short_url does not fail the send", async () => {
  reset();
  db.on("SET short_url", () => { throw new Error("write failed"); });
  await assert.doesNotReject(() => send());
  assert.equal(smsSent.length, 1);
  assert.match(smsSent[0].body, /tinyurl\.com\/masked01/);
});

// ── The shared-builder trap ──────────────────────────────────────────────────

test("EMAIL still carries the full URL — masking is SMS-only", () => {
  // buildChatLinkUrl is imported by both senders. Masking it globally would
  // have put a tinyurl in every confirmation email too, where there is no
  // carrier filter and a visible domain is what makes the mail trustworthy.
  const url = chatLinkEmail.buildChatLinkUrl(TOKEN);
  assert.equal(url, `https://confirms.justclara.ai/chat/${TOKEN}`);
});

// ── Sanitiser unit checks ────────────────────────────────────────────────────

test("toGsm7 leaves ordinary business names untouched", () => {
  for (const s of ["Total Fire & Security", "New Victorian Inn & Suites-Omaha", "Inspection Job #49707603"]) {
    assert.equal(chatLinkSms.toGsm7(s), s);
  }
});

test("toGsm7 handles null/empty without producing the string 'null'", () => {
  assert.equal(chatLinkSms.toGsm7(null), "");
  assert.equal(chatLinkSms.toGsm7(undefined), "");
  assert.equal(chatLinkSms.toGsm7(""), "");
});

test("a missing customer name degrades to a plain greeting", async () => {
  reset();
  await send({ customerName: null });
  assert.match(smsSent[0].body, /^Hi, please confirm/);
  assert.ok(!smsSent[0].body.includes("null"));
});

test("a missing job name drops the clause rather than leaving a dangling 'for'", async () => {
  reset();
  await send({ jobName: null });
  assert.ok(!/ for \./.test(smsSent[0].body));
  assert.ok(!smsSent[0].body.includes("null"));
  assert.match(smsSent[0].body, /appointment with Total Fire & Security/);
});
