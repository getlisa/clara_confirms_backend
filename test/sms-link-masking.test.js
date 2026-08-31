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
let resolvesImpl = async () => true;
const resolveCalls = [];
stub("services/link-shortener", {
  shorten: async (url) => { shortenCalls.push(url); return shortenImpl(url); },
  resolvesCleanlyTo: async (short, expected) => { resolveCalls.push([short, expected]); return resolvesImpl(short, expected); },
});

const cfg = {
  frontendUrl: "https://confirms.justclara.ai",
  smsLinkMasking: { enabled: true, provider: "tinyurl" },
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
  resolvesImpl = async () => true;
  resolveCalls.length = 0;
  cfg.smsLinkMasking = { enabled: true, provider: "tinyurl", ...over };
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

test("the shortener is handed the real chat URL", async () => {
  reset();
  await send();
  assert.deepEqual(shortenCalls.length, 1);
  assert.equal(shortenCalls[0], `https://confirms.justclara.ai/chat/${TOKEN}`,
    "no indirection: the short link redirects into the chat either way, so a /c/ hop bought nothing");
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

test("no link row → still masked, just not cached", async () => {
  // Dropping the /c/ indirection removed the need for the row: the chat URL is
  // built from the token alone, and the row is now only used to cache the
  // result. Callers without it (e.g. a path that only has the token) get
  // masking too, at the cost of re-minting next time.
  reset();
  db.on("FROM chat_links", []);
  await send({ link: null });
  assert.equal(smsSent.length, 1);
  assert.match(smsSent[0].body, /tinyurl\.com\/masked01/);
  assert.equal(db.matched("SET short_url").length, 0, "nothing to cache against");
});

// ── Idempotence ──────────────────────────────────────────────────────────────

test("a cached short_url is reused — but only after being verified", async () => {
  reset();
  await send({ link: { ...LINK, short_url: "https://tinyurl.com/cached" } });
  assert.equal(shortenCalls.length, 0, "a resend or retry must not re-mint a good link");
  assert.match(smsSent[0].body, /tinyurl\.com\/cached/);
  assert.equal(resolveCalls.length, 1, "the cache is checked, not trusted");
  assert.deepEqual(resolveCalls[0], ["https://tinyurl.com/cached", `https://confirms.justclara.ai/chat/${TOKEN}`]);
});

test("a POISONED cached short_url is discarded and re-minted", async () => {
  // This really happened: a row held "https://tinyurl.com/<our-own-code>",
  // a 404, and it was re-sent to a customer three times unchecked.
  reset();
  resolvesImpl = async (short) => !short.includes("S4b1esYZ6G");
  await send({ link: { ...LINK, short_url: "https://tinyurl.com/S4b1esYZ6G" } });
  assert.equal(shortenCalls.length, 1, "must re-mint rather than reuse a bad value");
  assert.match(smsSent[0].body, /tinyurl\.com\/masked01/);
  assert.ok(!smsSent[0].body.includes("S4b1esYZ6G"), "the bad link must never reach a customer again");
});

test("a poisoned cache is cleared so the next send does not re-check it", async () => {
  reset();
  resolvesImpl = async (short) => !short.includes("bad");
  await send({ link: { ...LINK, short_url: "https://tinyurl.com/bad" } });
  const cleared = db.calls.find((c) => c.sql.includes("SET short_url") && c.params[0] === null);
  assert.ok(cleared, "the row should be nulled, not left to fail verification forever");
});

test("if the cached link cannot be verified, the send still happens", async () => {
  reset();
  resolvesImpl = async () => { throw new Error("network down"); };
  await assert.doesNotReject(() => send({ link: { ...LINK, short_url: "https://tinyurl.com/cached" } }));
  assert.equal(smsSent.length, 1);
});

test("no short code is claimed any more — nothing needs one", async () => {
  reset();
  await send();
  assert.equal(db.matched("SET short_code").length, 0);
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

// ── Greeting priority: real contact > site > account, mirroring the email ──
// (chat-appointment-lookup-backend-request.md's sibling fix for
// chat-link-email.js — same bug, same fix, applied here too.)

test("a real contact name takes priority over the site and the account", async () => {
  reset();
  await send({ recipientName: "Dana Reed", siteName: "Columbus Park Apartments", customerName: "VareCo" });
  assert.match(smsSent[0].body, /^Hi Dana Reed, please confirm/);
});

test("falls back to the site name when no real contact is known", async () => {
  reset();
  await send({ recipientName: null, siteName: "Columbus Park Apartments", customerName: "VareCo" });
  assert.match(smsSent[0].body, /^Hi Columbus Park Apartments, please confirm/);
});

test("falls back to the account name only once the site is also unknown", async () => {
  reset();
  await send({ recipientName: null, siteName: null, customerName: "VareCo" });
  assert.match(smsSent[0].body, /^Hi VareCo, please confirm/);
});

test("with nothing at all known, greets generically — never a blank name", async () => {
  reset();
  await send({ recipientName: null, siteName: null, customerName: null });
  assert.match(smsSent[0].body, /^Hi, please confirm/);
});

// ── Naming the actual visit, not a bare job title ───────────────────────────

test("a known service summary replaces the bare job title", async () => {
  reset();
  await send({ serviceSummary: "Fire Alarm Inspection", jobName: "Inspection Job #49707603" });
  assert.match(smsSent[0].body, /please confirm your Fire Alarm Inspection visit with/);
  assert.ok(!smsSent[0].body.includes("Inspection Job #49707603"),
    "the bare job title must not show once the real visit is known");
});

test("with no service summary, falls back to the job-title phrasing exactly as before", async () => {
  reset();
  await send({ serviceSummary: null, jobName: "Inspection Job #49707603" });
  assert.match(smsSent[0].body, /please confirm your upcoming appointment for Inspection Job #49707603 with/);
});

// ── The trailing-slash trap ──────────────────────────────────────────────────

test("a trailing slash on FRONTEND_URL does not produce a double slash", () => {
  // One character in .env caused a cascade: FRONTEND_URL ended in "/", so
  // buildChatLinkUrl produced host//chat/<token>. The shortener normalised the
  // double slash when resolving, so the interception guard compared the
  // normalised target against the malformed original, declared the link
  // hijacked, and fell back to the unmasked URL — which the carrier then
  // blocked. Normalising in config is what stops all of that.
  const path = require("path");
  const configPath = require.resolve(path.join(__dirname, "..", "src", "config", "index.js"));
  const before = process.env.FRONTEND_URL;
  try {
    for (const raw of ["https://x.test/", "https://x.test//", "https://x.test"]) {
      process.env.FRONTEND_URL = raw;
      delete require.cache[configPath];
      const fresh = require(configPath);
      assert.equal(fresh.frontendUrl, "https://x.test", `${raw} should normalise`);
    }
  } finally {
    if (before === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = before;
    delete require.cache[configPath];
  }
});
