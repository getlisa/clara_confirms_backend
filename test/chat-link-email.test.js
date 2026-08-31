/**
 * The confirmation chat-link email — subject/greeting/body content, not
 * delivery mechanics (sendMail itself is stubbed; SendGrid is never called).
 *
 * The bug this pins: the greeting used to address the ServiceTrade ACCOUNT
 * name as if it were a person ("Hey VareCo!"), and the body named only a
 * bare job title/number ("Inspection Job #50049755") instead of the actual
 * visit — service, site, and date. Real `buildEmailTemplate` runs (only
 * `sendMail` is stubbed) so these tests catch a regression in the real HTML,
 * not a mocked shape of it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("config", { frontendUrl: "https://app.example.test", sendgrid: {} });

const realEmail = require("../src/utils/email");
const sendMailCalls = [];
stub("utils/email", {
  sendMail: async (args) => { sendMailCalls.push(args); return true; },
  buildEmailTemplate: realEmail.buildEmailTemplate,
});

const { sendConfirmationLinkEmail, buildChatLinkUrl } = require("../src/services/chat-link-email");

function reset() {
  sendMailCalls.length = 0;
  logger.reset();
}

test("buildChatLinkUrl encodes the token into the frontend chat path", () => {
  assert.equal(buildChatLinkUrl("abc 123"), "https://app.example.test/chat/abc%20123");
});

// ── Greeting name — never the raw account name ──────────────────────────────

test("greets by the real contact name when one is known", async () => {
  reset();
  await sendConfirmationLinkEmail({
    email: "a@b.test", recipientName: "Dana Reed", siteName: "Columbus Park Apartments",
    customerName: "VareCo", companyName: "Total Fire & Security", token: "t1",
  });
  const [{ html, text }] = sendMailCalls;
  assert.match(html, /Hi Dana Reed!/);
  assert.match(text, /^Hi Dana Reed!/);
  assert.doesNotMatch(html, /VareCo/, "a real contact name takes priority over the account name");
});

test("falls back to the site/property name when no real contact is known", async () => {
  reset();
  await sendConfirmationLinkEmail({
    email: "a@b.test", siteName: "Columbus Park Apartments", customerName: "VareCo",
    companyName: "Total Fire & Security", token: "t1",
  });
  const [{ html }] = sendMailCalls;
  assert.match(html, /Hi Columbus Park Apartments!/);
});

test("falls back to the account name only once site is also unknown", async () => {
  reset();
  await sendConfirmationLinkEmail({
    email: "a@b.test", customerName: "VareCo", companyName: "Total Fire & Security", token: "t1",
  });
  const [{ html }] = sendMailCalls;
  assert.match(html, /Hi VareCo!/);
});

test("falls back to a generic greeting when nothing at all is known — never blank, never 'Hey'", async () => {
  reset();
  await sendConfirmationLinkEmail({ email: "a@b.test", companyName: "Total Fire & Security", token: "t1" });
  const [{ html, text }] = sendMailCalls;
  assert.match(html, /Hi there!/);
  assert.match(text, /^Hi there!/);
  assert.doesNotMatch(html, /Hey/, "this email is deliberately \"Hi\", not the shared template's default \"Hey\"");
});

// ── Body/subject — the actual visit, not a bare job title ───────────────────

test("names the service, site, and date when a next appointment is known", async () => {
  reset();
  await sendConfirmationLinkEmail({
    email: "a@b.test", siteName: "Columbus Park Apartments", customerName: "VareCo",
    companyName: "Total Fire & Security", jobName: "Inspection Job #50049755",
    serviceSummary: "Fire Alarm Inspection", scheduledLabel: "Thursday, August 27, 2026 at 1:00 PM",
    token: "t1",
  });
  const [{ subject, html, text }] = sendMailCalls;
  assert.equal(subject, "Please confirm your upcoming Fire Alarm Inspection visit");
  assert.match(html, /Please confirm your Fire Alarm Inspection visit at Columbus Park Apartments on Thursday, August 27, 2026 at 1:00 PM\./);
  assert.match(text, /Fire Alarm Inspection visit at Columbus Park Apartments on Thursday, August 27, 2026 at 1:00 PM/);
  assert.doesNotMatch(html, /Inspection Job #50049755/, "the bare job title must not be what the customer sees once real visit detail is known");
});

test("falls back to the job name when there is no next appointment to describe", async () => {
  reset();
  await sendConfirmationLinkEmail({
    email: "a@b.test", customerName: "VareCo", companyName: "Total Fire & Security",
    jobName: "Inspection Job #50049755", token: "t1",
  });
  const [{ subject, html }] = sendMailCalls;
  assert.equal(subject, "Please confirm your upcoming appointment for Inspection Job #50049755");
  assert.match(html, /Please confirm your upcoming appointment for Inspection Job #50049755\./);
});

test("the CTA body copy asks the customer to confirm, with a link to chat — no reschedule/cancel mention", async () => {
  reset();
  await sendConfirmationLinkEmail({ email: "a@b.test", companyName: "Total Fire & Security", token: "t1" });
  const [{ html }] = sendMailCalls;
  assert.match(html, /Click the button below to chat with us and confirm — it only takes a minute\./);
  assert.doesNotMatch(html, /reschedule, or cancel/);
});

test("the disclaimer footer is still present", async () => {
  reset();
  await sendConfirmationLinkEmail({ email: "a@b.test", companyName: "Total Fire & Security", token: "t1" });
  const [{ html }] = sendMailCalls;
  assert.match(html, /If you weren't expecting this, you can safely ignore this email\./);
});

test("the button links to the real chat URL for this token", async () => {
  reset();
  await sendConfirmationLinkEmail({ email: "a@b.test", companyName: "Total Fire & Security", token: "abc123" });
  const [{ html }] = sendMailCalls;
  assert.match(html, /href="https:\/\/app\.example\.test\/chat\/abc123"/);
});

// ── buildEmailTemplate's greetingWord override (shared utility) ────────────

test("buildEmailTemplate defaults to 'Hey' when no greetingWord is given — other callers are unaffected", () => {
  const html = realEmail.buildEmailTemplate({ userName: "Sam", title: "t", bodyHtml: "<p>x</p>" });
  assert.match(html, /Hey Sam!/);
});

test("buildEmailTemplate honors an explicit greetingWord override", () => {
  const html = realEmail.buildEmailTemplate({ userName: "Sam", greetingWord: "Hi", title: "t", bodyHtml: "<p>x</p>" });
  assert.match(html, /Hi Sam!/);
  assert.doesNotMatch(html, /Hey Sam/);
});
