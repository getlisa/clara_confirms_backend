/**
 * The service link must not go out until the customer has confirmed the
 * address, and both agents must actually know the contact's details.
 *
 * The gate is not merely about mailing the wrong person.
 * resolve_service_link_contact CREATES a ServiceTrade contact when no existing
 * one matches the address, so acting on an unconfirmed (or mis-transcribed)
 * email writes a junk contact into the customer's CRM as well. Both prompts
 * ask the agent to read the address back — but a prompt is advisory and the
 * model can go straight to the tool, so the refusal lives in the handler.
 *
 * Fake db throughout; no CRM calls, no network.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeDb } = require("./helpers/fake-db");
const { stub, silentLogger } = require("./helpers/stub-modules");

const db = createFakeDb();
const logger = silentLogger();
stub("db", db);
stub("utils/logger", logger);

// If the gate ever lets an unconfirmed address through, these record it.
const searched = [];
const created = [];
const sent = [];
stub("services/servicetrade-service-link", {
  searchContacts: async (companyId, email) => { searched.push(email); return []; },
  createContact: async (args) => { created.push(args); return { id: 1 }; },
  sendRecordedServiceLink: async (args) => { sent.push(args); return { sent: true }; },
});
stub("db/service-link-messages", { upsertRecipient: async () => {}, getByRetellCallId: async () => null });
stub("db/chat-links", { setState: async () => {} });

const resolveTool = require("../src/confirmation-agent/tools/handlers/resolve-service-link-contact");
const prompt = require("../src/confirmation-agent/graph/prompt");

const CTX = { configurable: { ctx: { companyId: 9, jobId: 10, threadId: "tok", jobRef: "77", customerRef: "5" } } };

function reset() {
  db.reset(); logger.reset();
  searched.length = 0; created.length = 0; sent.length = 0;
  // sendServiceLinkCore's isServiceTradeJob guard checks this before doing
  // anything else — every test here is exercising a ServiceTrade job, so
  // seed it fresh on every reset (db.reset() clears all routes too).
  db.on("SELECT source FROM jobs WHERE", [{ source: "servicetrade" }]);
}

// ── The gate ─────────────────────────────────────────────────────────────────

test("omitting email_confirmed refuses, and touches nothing", async () => {
  reset();
  const out = JSON.parse(await resolveTool.run({ email: "ops@acme.test" }, CTX));
  assert.equal(out.status, "needs_email_confirmation");
  assert.equal(searched.length, 0, "must not even search the CRM on an unconfirmed address");
  assert.equal(created.length, 0, "and must certainly not create a contact");
  assert.equal(sent.length, 0);
});

test("email_confirmed=false refuses just the same", async () => {
  reset();
  const out = JSON.parse(await resolveTool.run({ email: "ops@acme.test", email_confirmed: false }, CTX));
  assert.equal(out.status, "needs_email_confirmation");
  assert.equal(searched.length, 0);
});

test("the refusal tells the agent what to do next, and names the address", async () => {
  reset();
  const out = JSON.parse(await resolveTool.run({ email: "ops@acme.test", email_confirmed: false }, CTX));
  assert.equal(out.email, "ops@acme.test");
  assert.match(out.message, /ops@acme\.test/);
  assert.match(out.message, /email_confirmed=true/, "must say how to proceed, not just that it failed");
});

test("a truthy-but-not-true value does NOT satisfy the gate", async () => {
  // Guards the sloppy `if (!email_confirmed)` reading: the model asserting
  // "yes" as a bare string is not the same as the customer having said yes.
  for (const v of ["yes", "confirmed", 1, {}]) {
    reset();
    const out = JSON.parse(await resolveTool.run({ email: "ops@acme.test", email_confirmed: v }, CTX));
    assert.equal(out.status, "needs_email_confirmation", `${JSON.stringify(v)} must not pass the gate`);
    assert.equal(searched.length, 0);
  }
});

test("email_confirmed=true proceeds to the CRM lookup", async () => {
  reset();
  await resolveTool.run({ email: "ops@acme.test", email_confirmed: true }, CTX).catch(() => {});
  assert.deepEqual(searched, ["ops@acme.test"], "the confirmed address is the one looked up");
});

test("a corrected address is what gets used, not the one on file", async () => {
  reset();
  await resolveTool.run({ email: "correct@acme.test", email_confirmed: true }, CTX).catch(() => {});
  assert.deepEqual(searched, ["correct@acme.test"]);
});

test("the refusal is logged — a silent no-op would look like the tool hung", async () => {
  reset();
  await resolveTool.run({ email: "ops@acme.test" }, CTX);
  assert.ok(logger.records.info.some(([msg]) => /not confirmed/i.test(msg)));
});

test("the tool schema exposes email_confirmed as a required boolean", () => {
  const shape = resolveTool.schema?.shape ?? resolveTool.schema?._def?.shape?.();
  assert.ok(shape?.email_confirmed, "the model cannot set a parameter that isn't declared");
  assert.equal(shape.email_confirmed.isOptional?.() ?? false, false, "must not be optional");
});

// ── Contact context in the chat prompt ───────────────────────────────────────

function chatPrompt(opts = {}) {
  const ctx = {
    ok: true,
    job: { id: 1, job_number: "J-1", title: "Annual Inspection", customer: { name: "Acme Property Group" }, comments: [] },
    appointments: { upcoming: [], history: [] },
    counts: { upcoming: 0, unconfirmed: 0, all_confirmed: true },
    phase: "confirming",
  };
  return prompt.build(ctx, { companyName: "Clara Fire", ...opts });
}

test("the contact's email and phone are given as context, not buried in the send step", () => {
  const out = chatPrompt({ recipientName: "Dana Reed", recipientEmail: "dana@acme.test", recipientPhone: "+15551234567" });
  const header = out.slice(0, out.indexOf("── CURRENT JOB DATA"));
  assert.match(header, /CONTACT & JOB DATA/);
  assert.match(header, /dana@acme\.test/, "email must be visible before the service-link section");
  assert.match(header, /\+15551234567/);
  assert.match(header, /Dana Reed/);
});

test("missing details read as 'none', never as a blank or the word null", () => {
  const out = chatPrompt({ recipientName: "Dana Reed" });
  assert.match(out, /- Email: none on file/);
  assert.match(out, /- Phone: none on file/);
  assert.ok(!out.includes("Email on file: null"));
  assert.ok(!out.includes("Email on file: undefined"));
});

test("the person is named, and the site is flagged as a place rather than a person", () => {
  const out = chatPrompt({ recipientName: "Dana Reed", recipientEmail: "dana@acme.test" });
  assert.match(out, /You are texting Dana Reed\./,
    "the agent addresses the human, not the account");
  assert.match(out, /is a LOCATION NAME — not a person/,
    "and knows the account name is a place, so it never salutes it");
});

test("when the recipient IS the account holder, that note is omitted", () => {
  const out = chatPrompt({ recipientName: "Acme Property Group" });
  assert.ok(!out.includes("not the account holder"));
});

test("the agent is told not to volunteer the contact details", () => {
  // "Never read them out unprompted" became "never volunteer them at any
  // other point" once the identity check (WHO YOU'RE TALKING TO) started
  // legitimately reading these back — the ban on volunteering them
  // elsewhere is unchanged, just no longer an absolute ban on reading them
  // back at all.
  const out = chatPrompt({ recipientEmail: "dana@acme.test", recipientPhone: "+15551234567" });
  assert.match(out, /never volunteer them at any other point/i);
});

// ── The chat prompt states the gate ──────────────────────────────────────────

test("the prompt requires an explicit yes and names the parameter", () => {
  const out = chatPrompt({ recipientEmail: "dana@acme.test" });
  assert.match(out, /EXPLICIT YES ON THE ADDRESS BEFORE SENDING/);
  assert.match(out, /email_confirmed=true/);
  assert.match(out, /is that the right one to send it to\?/, "it should read the address back, not ask blind");
});

test("with no email on file the prompt asks and reads back, rather than inventing one", () => {
  const out = chatPrompt({});
  assert.match(out, /We have no email on file for this conversation — ask for it/);
  assert.match(out, /read back what they give you/);
});

test("the prompt explains WHY a wrong address matters — it writes to the CRM", () => {
  const out = chatPrompt({ recipientEmail: "dana@acme.test" });
  assert.match(out, /CREATES one in the CRM/);
});
