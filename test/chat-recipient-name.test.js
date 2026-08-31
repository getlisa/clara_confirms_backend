/**
 * The chat agent must greet the person we actually shared the link with — and
 * must NOT invent one when we don't know it.
 *
 * The bug: chat_links stored only recipient_contact_id, which is NULL whenever
 * the link went to the account's own email/phone (9 of 10 live links). The agent
 * then fell back to customers.full_name. On this platform that is never a
 * person: all 138 customers across companies 8 and 9 have first_name/last_name
 * NULL and a full_name like "JACK LTR" or "123 California Ave", and on 72 of 215
 * jobs it is byte-for-byte the LOCATION name — so the prompt said both
 * '"X" is a LOCATION NAME — never address it as a person' and 'You are texting X.'
 *
 * Fixed by snapshotting the recipient on the link at SEND time (migration 095)
 * and refusing the account-name fallback.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

stub("utils/logger", silentLogger());

const queries = [];
let queryImpl = async () => ({ rows: [], rowCount: 0 });
stub("db", { query: async (sql, params) => { queries.push({ sql, params }); return queryImpl(sql, params); } });

let contactImpl = async () => null;
stub("confirmation-agent/tools/confirmer-label", { resolveContact: async (...a) => contactImpl(...a) });
stub("db/llm-call-logs", { logCall: async () => {} });
stub("services/servicetrade-comments", { postConfirmationAgentComment: async () => {} });
let graphImpl = () => ({});
stub("confirmation-agent/graph/build", { getGraph: async () => graphImpl(), phaseFromContext: () => "confirming" });

const chatLinksDb = require("../src/db/chat-links");
const { build } = require("../src/confirmation-agent/graph/prompt");

function reset() {
  queries.length = 0;
  queryImpl = async () => ({ rows: [], rowCount: 0 });
  contactImpl = async () => null;
  graphImpl = () => ({});
}
const find = (frag) => queries.find((q) => q.sql.includes(frag));

// ── Storing who we sent it to ───────────────────────────────────────────────

test("a send records the name, address and number it was addressed to", async () => {
  reset();
  await chatLinksDb.setRecipient("tok", { name: "Shivam Koli", email: "s@x.test", phone: "+15551234567" });
  const q = find("UPDATE chat_links SET recipient_name");
  assert.match(q.sql, /recipient_name = \$2, recipient_email = \$3, recipient_phone = \$4/);
  assert.deepEqual(q.params, ["tok", "Shivam Koli", "s@x.test", "+15551234567"]);
});

test("a field that is not mentioned is left alone", async () => {
  // The manual send-email and send-sms routes each know only their own medium.
  // A whole-row write there would blank the address the other leg recorded.
  reset();
  await chatLinksDb.setRecipient("tok", { email: "s@x.test" });
  const q = find("UPDATE chat_links SET");
  assert.equal(q.sql.includes("recipient_phone"), false, "the phone we already had must survive an email re-send");
  assert.equal(q.sql.includes("recipient_name"), false);
  assert.deepEqual(q.params, ["tok", "s@x.test"]);
});

test("an explicit null CLEARS, so a re-send to the account drops the old contact's name", async () => {
  reset();
  await chatLinksDb.setRecipient("tok", { name: null, email: "office@x.test" });
  const q = find("UPDATE chat_links SET");
  assert.match(q.sql, /recipient_name = \$2/);
  assert.deepEqual(q.params, ["tok", null, "office@x.test"],
    "null must mean 'clear', not 'unknown' — otherwise we keep greeting someone who is no longer on the other end");
});

test("an empty update issues no query at all", async () => {
  reset();
  await chatLinksDb.setRecipient("tok", {});
  assert.equal(queries.length, 0);
});

// ── Choosing the name the agent sees ────────────────────────────────────────

const agent = require("../src/confirmation-agent");
const { resolveRecipient } = agent;

test("the link's own snapshot wins over a live contact lookup", async () => {
  // The snapshot is who the email/SMS was ADDRESSED to. Re-resolving would
  // silently follow a rename, or lose the name entirely on a deleted contact.
  reset();
  contactImpl = async () => ({ name: "Renamed Since", email: "new@x.test", phone: "+1999" });
  const r = await resolveRecipient(8, 51153, "cust@x.test", "+1000", { name: "Shivam Koli", email: "s@x.test", phone: "+1555" });
  assert.equal(r.recipientName, "Shivam Koli");
  assert.equal(r.recipientEmail, "s@x.test");
});

test("with no snapshot it still falls back to resolving the contact", async () => {
  reset();
  contactImpl = async () => ({ name: "Property Manager", email: "pm@x.test", phone: "+1777" });
  const r = await resolveRecipient(8, 51153, "cust@x.test", "+1000", null);
  assert.equal(r.recipientName, "Property Manager");
});

test("no contact means NO NAME — never the customer record", async () => {
  reset();
  const r = await resolveRecipient(8, null, "cust@x.test", "+1000", null);
  assert.equal(r.recipientName, null,
    "customers.full_name is an account ('JACK LTR'), not a person to greet");
  assert.equal(r.recipientEmail, "cust@x.test", "the account's address is still a fine destination");
  assert.equal(r.recipientPhone, "+1000");
});

test("a snapshot with only an address carries no name", async () => {
  // The manual send routes: we know where it went, never who read it.
  reset();
  const r = await resolveRecipient(8, null, "cust@x.test", "+1000", { name: null, email: "typed@x.test", phone: null });
  assert.equal(r.recipientName, null);
  assert.equal(r.recipientEmail, "typed@x.test");
  assert.equal(r.recipientPhone, "+1000", "an absent leg falls back rather than going blank");
});

// ── What the prompt then says ───────────────────────────────────────────────

function ctxFor({ customerName = "JACK LTR", locationName = "Qahwah House" } = {}) {
  return {
    ok: true,
    phase: "confirming",
    job: {
      id: 1, job_number: "48767205", title: "Backflow PM", description: null,
      job_type: "inspection", status: "scheduled", scheduled_date: null,
      comments: [], notes: [], location_name: locationName,
      customer: { name: customerName, phone: "+15551230000", email: "ap@x.test", address: "1 Main St" },
      technician: null,
    },
    appointments: { upcoming: [], next: null, history: [] },
    counts: { upcoming: 0, confirmed: 0, unconfirmed: 0, all_confirmed: false },
  };
}

test("a known recipient is named, and the agent is told to use it", () => {
  const p = build(ctxFor(), { companyName: "Acme", recipientName: "Shivam Koli" });
  assert.match(p, /You are texting Shivam Koli/);
});

test("an unknown recipient produces an explicit do-not-guess, not an account name", () => {
  const p = build(ctxFor(), { companyName: "Acme", recipientName: null });
  assert.ok(!/You are texting JACK LTR/.test(p),
    "the account name must never be presented as the person being texted");
  assert.match(p, /do not have the NAME/i);
  assert.match(p, /never guess one/i);
});

test("the prompt no longer contradicts itself when the account IS the location", () => {
  // 72 of 215 live jobs have customers.full_name === locations.name.
  const p = build(ctxFor({ customerName: "Dodge County Courthouse", locationName: "Dodge County Courthouse" }),
    { companyName: "Acme", recipientName: null });
  assert.match(p, /"Dodge County Courthouse" is a LOCATION NAME — not a person/,
    "the location guard still fires");
  assert.ok(!/You are texting Dodge County Courthouse/.test(p),
    "and nothing else in the prompt now tells it to address that same string as a human");
});

test("a named recipient does not suppress the location guard", () => {
  const p = build(ctxFor(), { companyName: "Acme", recipientName: "Shivam Koli" });
  assert.match(p, /"Qahwah House" is a LOCATION NAME/);
  assert.match(p, /You are texting Shivam Koli/);
});

// ── Fallback: work backwards from the delivery ──────────────────────────────
//
// The nominated-contact path only fires when someone was NOMINATED, which on
// live data is 1 link in 10. For the other nine the link still went to a real
// person's inbox or phone — so the send log plus the contacts table can name
// them: token → destination → contact.

const sendEvents = require("../src/db/chat-link-send-events");

test("the lookup starts from the most recent SUCCESSFUL send", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await sendEvents.resolveRecipientForToken(8, "tok");
  const q = find("chat_link_send_events");
  assert.match(q.sql, /ORDER BY ok DESC, created_at DESC, id DESC\s*\n?\s*LIMIT 1/,
    "a delivered send beats a failed one; then most recent wins");
  assert.match(q.sql, /company_id = \$1 AND chat_link_token = \$2/);
  assert.deepEqual(q.params, [8, "tok"]);
});

test("an emailed link matches on the email column, case-insensitively", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  await sendEvents.resolveRecipientForToken(8, "tok");
  const sql = find("chat_link_send_events").sql;
  assert.match(sql, /lower\(TRIM\(ct\.email\)\) = lower\(TRIM\(ev\.destination\)\)/);
});

test("a texted link matches on mobile OR phone, as digits", async () => {
  // The send log stores E.164 (+14026201781); contacts store "402-620-1781".
  // A literal comparison never matches, so both sides are stripped to digits.
  reset();
  queryImpl = async () => ({ rows: [] });
  await sendEvents.resolveRecipientForToken(8, "tok");
  const sql = find("chat_link_send_events").sql;
  assert.match(sql, /ct\.mobile/);
  assert.match(sql, /ct\.phone/);
  assert.match(sql, /regexp_replace\(COALESCE\(ct\.mobile, ''\), '\[\^0-9\]', '', 'g'\)/);
  assert.match(sql, /right\(.*, 10\)/, "last 10 digits, so +1 and bare US numbers compare equal");
  assert.match(sql, /length\(.*\) >= 10/,
    "without a length floor a blank column would suffix-match every destination");
});

test("a mobile hit outranks a phone hit, and id breaks the tie", async () => {
  // +14026201781 really does match two contact rows — one by phone, one by
  // mobile — with DIFFERENT names. Texting a number makes the mobile owner the
  // better answer, and without a tiebreak the same read could flip between them.
  reset();
  queryImpl = async () => ({ rows: [] });
  await sendEvents.resolveRecipientForToken(8, "tok");
  const sql = find("chat_link_send_events").sql;
  assert.match(sql, /CASE WHEN[\s\S]*ct\.mobile[\s\S]*THEN 1 ELSE 2 END AS rank/);
  assert.match(sql, /ORDER BY rank, ct\.id/);
});

test("the contact search never leaves the company", async () => {
  // +14155201480 belongs to a different person in company 8 than in company 9.
  reset();
  queryImpl = async () => ({ rows: [] });
  await sendEvents.resolveRecipientForToken(9, "tok");
  assert.match(find("chat_link_send_events").sql, /ct\.company_id = \$1/);
});

test("a destination we cannot place returns the address but no name", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ medium: "email", destination: "nobody@x.test", contact_id: null, name: null, email: null, phone: null }] });
  const r = await sendEvents.resolveRecipientForToken(8, "tok");
  assert.equal(r.name, null, "better anonymous than wrong");
  assert.equal(r.email, "nobody@x.test", "we still know where it went");
});

test("a link that was never sent resolves to nothing at all", async () => {
  reset();
  queryImpl = async () => ({ rows: [] });
  assert.equal(await sendEvents.resolveRecipientForToken(8, "tok"), null);
});

test("an SMS destination becomes the phone, not the email", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ medium: "sms", destination: "+14026201781", contact_id: 5, name: "Ashley Dahl", email: "a@x.test", phone: "402-620-1781" }] });
  const r = await sendEvents.resolveRecipientForToken(8, "tok");
  assert.deepEqual([r.name, r.phone, r.email], ["Ashley Dahl", "+14026201781", "a@x.test"]);
});

// ── How the agent uses it ───────────────────────────────────────────────────

test("with nobody nominated, the agent names whoever the link was sent to", async () => {
  reset();
  queryImpl = async () => ({ rows: [{ medium: "sms", destination: "+919625694975", contact_id: 51153, name: "Shivam Koli", email: "shivam@x.test", phone: "+919625694975" }] });
  const r = await resolveRecipient(8, null, "account@x.test", "+1000", null, "tok");
  assert.equal(r.recipientName, "Shivam Koli");
});

test("a snapshotted ADDRESS does not suppress the name lookup", async () => {
  // The regression this ordering exists for: every link sent after migration
  // 095 has recipient_email/phone stamped but recipient_name null, so a
  // "snapshot has something, return early" shortcut would skip the one lookup
  // that can supply a name — and every one of those links would go back to
  // being greeted anonymously.
  reset();
  queryImpl = async () => ({ rows: [{ medium: "sms", destination: "+919625694975", contact_id: 51153, name: "Shivam Koli", email: null, phone: "+919625694975" }] });
  const r = await resolveRecipient(8, null, "account@x.test", "+1000", { name: null, email: "sent-to@x.test", phone: null }, "tok");
  assert.equal(r.recipientName, "Shivam Koli");
  assert.equal(r.recipientEmail, "sent-to@x.test", "but the address we actually used still wins");
});

test("a name we already have is never overridden by the fallback", async () => {
  reset();
  let called = false;
  queryImpl = async () => { called = true; return { rows: [] }; };
  const r = await resolveRecipient(8, null, "account@x.test", "+1000", { name: "Snapshot Name" }, "tok");
  assert.equal(r.recipientName, "Snapshot Name");
  assert.equal(called, false, "no reason to go to the database at all");
});

test("a failing lookup degrades to no name rather than breaking the chat", async () => {
  reset();
  queryImpl = async () => { throw new Error("contacts table gone"); };
  const r = await resolveRecipient(8, null, "account@x.test", "+1000", null, "tok");
  assert.equal(r.recipientName, null);
  assert.equal(r.recipientEmail, "account@x.test", "the conversation still opens");
});

// ── ensureOpened surfaces the same resolution to the widget ─────────────────
// GET /:token needs the resolved contact (not just the messages) so the
// widget can pre-fill the service-link email step with a real default —
// ensureOpened already computes this for the prompt; it must hand it back
// out too, on both the "just opened" and "already opened" branches.

test("ensureOpened returns the resolved recipient alongside the messages, on an already-opened link", async () => {
  reset();
  graphImpl = () => ({ getState: async () => ({ values: { messages: [] } }) });
  // An empty checkpoint would take the "just opened" branch and try to
  // actually run the graph — this test is only about the plumbing of the
  // fields, so give it one prior message to take the cheap read-only branch.
  const { AIMessage } = require("@langchain/core/messages");
  graphImpl = () => ({ getState: async () => ({ values: { messages: [new AIMessage("Hi there")] } }) });

  const out = await agent.ensureOpened({
    companyId: 8, jobId: 900, token: "tok", companyName: "Clara Fire",
    recipient: { name: "Shivam Koli", email: "shivam@x.test", phone: "+15551234567" },
  });

  assert.equal(out.recipientName, "Shivam Koli");
  assert.equal(out.recipientEmail, "shivam@x.test");
  assert.equal(out.recipientPhone, "+15551234567");
  assert.ok(Array.isArray(out.messages));
});
