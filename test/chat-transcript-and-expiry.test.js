/**
 * Two features that share one source of truth — the LangGraph checkpointer.
 *
 * 1. A STAFF transcript for the Logs detail sheet. Calls have one; chats had only
 *    lifecycle timestamps.
 * 2. The CRM comment for a chat that reached an outcome and then EXPIRED. Comments
 *    were posted only from end_conversation, so a customer who confirmed and then
 *    closed the tab left the outcome in our database and nowhere else. Observed
 *    live: chat link 69 confirmed appointment 110735, zero comments posted.
 *
 * The dangerous parts, and what these pin:
 *   - reading a conversation must NEVER start one (ensureOpened would generate an
 *     opening turn on a link the customer never opened);
 *   - create_appointment must NOT trigger an expiry comment (product decision),
 *     so the expiry path uses a narrower tool set than the normal path;
 *   - the comment must post at most once.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { HumanMessage, AIMessage, ToolMessage } = require("@langchain/core/messages");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });
stub("db/chat-links", {
  setStateByToken: async () => {},
  markEnded: async () => true,
  markOutcomeCommentPosted: async (token) => { marked.push(token); },
});
// index.js destructures this at import time, so the stub needs a swappable
// implementation — reassigning the module property later would not be seen.
let postImpl = async (args) => { posted.push(args); };
stub("services/servicetrade-comments", {
  postConfirmationAgentComment: async (args) => postImpl(args),
});
stub("confirmation-agent/tools/confirmer-label", { resolveContact: async () => null });

const turns = [];
stub("db/llm-call-logs", { logCall: async () => {}, listTurns: async () => turns });

// A graph whose state is whatever the test sets, and which records any attempt
// to actually RUN it — reading must never invoke.
let STATE = [];
const invocations = [];
stub("confirmation-agent/graph/build", {
  getGraph: async () => ({
    getState: async () => ({ values: { messages: STATE } }),
    invoke: async (...a) => { invocations.push(a); },
    streamEvents: async function* () { invocations.push(["stream"]); },
  }),
  phaseFromContext: () => "confirming",
});

const posted = [];
const marked = [];
const agent = require("../src/confirmation-agent");

function reset(state = []) {
  STATE = state;
  turns.length = 0; posted.length = 0; marked.length = 0; invocations.length = 0;
  postImpl = async (args) => { posted.push(args); };
  logger.reset();
}

const TRIGGER = "(This is a text chat, not a phone call. Please begin now with your chat-appropriate opening message.)";

/** An AI message that called `tool`, plus the matching successful ToolMessage. */
function toolPair(tool, args, result) {
  const id = `call_${tool}`;
  return [
    new AIMessage({ content: "", tool_calls: [{ name: tool, id, args }] }),
    new ToolMessage({ content: JSON.stringify({ success: true, ...result }), tool_call_id: id, name: tool }),
  ];
}

// ── 1. Reading a conversation ───────────────────────────────────────────────

test("the transcript is the same shape the customer's widget receives", async () => {
  reset([
    new HumanMessage(TRIGGER),
    new AIMessage("Hi — confirming your visit."),
    new HumanMessage("yes please"),
    new AIMessage("Confirmed!"),
  ]);
  const { messages, message_count } = await agent.getConversation(8, "tok");

  assert.equal(message_count, 4, "the raw count includes what is not shown");
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [
    ["agent", "Hi — confirming your visit."],
    ["user", "yes please"],
    ["agent", "Confirmed!"],
  ]);
});

test("the synthetic opening trigger is never shown to staff", async () => {
  reset([new HumanMessage(TRIGGER), new AIMessage("Hi there.")]);
  const { messages } = await agent.getConversation(8, "tok");
  assert.ok(!messages.some((m) => m.content === TRIGGER),
    "it is a prompt device, not something the customer typed");
});

test("a service link survives as a structured card", async () => {
  reset([
    new AIMessage("Sending that now."),
    new ToolMessage({
      content: JSON.stringify({ success: true, url: "https://app.servicetrade.com/x", job_name: "PM" }),
      tool_call_id: "t1", name: "get_service_link",
    }),
  ]);
  const { messages } = await agent.getConversation(8, "tok");
  const card = messages.find((m) => m.type === "service_link");
  assert.ok(card, "the detail sheet should show the link the customer was given");
  assert.equal(card.url, "https://app.servicetrade.com/x");
});

test("reading NEVER runs the graph", async () => {
  // ensureOpened would mark the link opened and generate an opening turn — a
  // staff member glancing at Logs would start the conversation.
  reset([new AIMessage("hello")]);
  await agent.getConversation(8, "tok");
  assert.deepEqual(invocations, [], "no invoke, no stream — getState only");
});

test("an unopened link reads as empty rather than being opened", async () => {
  reset([]);
  const { messages, message_count } = await agent.getConversation(8, "never-opened");
  assert.deepEqual(messages, []);
  assert.equal(message_count, 0);
  assert.deepEqual(invocations, []);
});

test("timestamps are borrowed from the turn log, in order", async () => {
  const t1 = new Date("2026-08-13T10:00:00Z");
  const t2 = new Date("2026-08-13T10:05:00Z");
  reset([
    new HumanMessage(TRIGGER),
    new AIMessage("Hi — confirming your visit."),
    new HumanMessage("yes please"),
    new AIMessage("Confirmed!"),
  ]);
  turns.push(
    { human_message: TRIGGER, ai_message: "Hi — confirming your visit.", created_at: t1 },
    { human_message: "yes please", ai_message: "Confirmed!", created_at: t2 },
  );

  const { messages } = await agent.getConversation(8, "tok");
  assert.deepEqual(messages.map((m) => m.created_at), [t1, t2, t2]);
});

test("a missing turn log leaves timestamps null instead of failing", async () => {
  reset([new AIMessage("hello")]);
  const logs = require("../src/db/llm-call-logs");
  const original = logs.listTurns;
  logs.listTurns = async () => { throw new Error("table gone"); };
  try {
    const { messages } = await agent.getConversation(8, "tok");
    assert.equal(messages[0].created_at, null, "the transcript still renders");
    assert.equal(logger.records.warn.length, 1);
  } finally { logs.listTurns = original; }
});

// ── 2. The expiry comment ───────────────────────────────────────────────────

test("an expired chat that confirmed something posts the comment", async () => {
  reset([new HumanMessage("yes"), ...toolPair("confirm_appointment", { appointment_id: 12 }, { appointment_id: 12 })]);
  const out = await agent.postExpiredOutcomeComment({ companyId: 8, jobId: 900, token: "tok" });

  assert.equal(out.posted, true);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].expired, true, "the office must be able to tell this from a clean close");
  assert.deepEqual(posted[0].appointmentIds, ["12"]);
  assert.deepEqual(marked, ["tok"], "and the link is stamped so it cannot post twice");
});

test("reschedule and cancel count too", async () => {
  for (const [tool, args] of [
    ["reschedule_appointment", { appointment_id: 12, scheduled_start: "2026-09-01T08:00:00" }],
    ["cancel_appointment", { appointment_id: 12, reason: "not needed" }],
  ]) {
    reset([...toolPair(tool, args, { appointment_id: 12 })]);
    const out = await agent.postExpiredOutcomeComment({ companyId: 8, jobId: 900, token: "tok" });
    assert.equal(out.posted, true, `${tool} is an outcome`);
  }
});

test("a chat-BOOKED appointment posts nothing — deliberately narrower than the normal path", async () => {
  // Product decision: create_appointment is in ACTIONABLE_TOOLS but not in the
  // expiry set. Reusing ACTIONABLE_TOOLS here would silently change behaviour.
  reset([...toolPair("create_appointment", { scheduled_start: "2026-09-01T08:00:00" }, { appointment_id: 99 })]);
  const out = await agent.postExpiredOutcomeComment({ companyId: 8, jobId: 900, token: "tok" });

  assert.equal(out.posted, false);
  assert.equal(out.reason, "no_outcome");
  assert.equal(posted.length, 0);
  assert.ok(!agent.EXPIRY_OUTCOME_TOOLS.has("create_appointment"));
});

test("a conversation with no outcome posts nothing", async () => {
  reset([new HumanMessage("what services?"), new AIMessage("Backflow and sprinkler.")]);
  const out = await agent.postExpiredOutcomeComment({ companyId: 8, jobId: 900, token: "tok" });
  assert.equal(out.reason, "no_outcome");
  assert.equal(posted.length, 0);
  assert.deepEqual(marked, [], "nothing was posted, so nothing is stamped");
});

test("a link that was never opened posts nothing", async () => {
  reset([]);
  const out = await agent.postExpiredOutcomeComment({ companyId: 8, jobId: 900, token: "tok" });
  assert.equal(out.reason, "no_conversation");
  assert.equal(posted.length, 0);
});

test("a FAILED tool call is not an outcome", async () => {
  reset([
    new AIMessage({ content: "", tool_calls: [{ name: "confirm_appointment", id: "c1", args: { appointment_id: 12 } }] }),
    new ToolMessage({ content: JSON.stringify({ success: false, error: "gone" }), tool_call_id: "c1", name: "confirm_appointment" }),
  ]);
  const out = await agent.postExpiredOutcomeComment({ companyId: 8, jobId: 900, token: "tok" });
  assert.equal(out.reason, "no_outcome", "a comment claiming a confirmation that failed would be worse than none");
});

test("a posting failure is swallowed so the sweep continues", async () => {
  reset([...toolPair("confirm_appointment", { appointment_id: 12 }, { appointment_id: 12 })]);
  postImpl = async () => { throw new Error("ServiceTrade 502"); };
  const out = await agent.postExpiredOutcomeComment({ companyId: 8, jobId: 900, token: "tok" });
  assert.equal(out.posted, false);
  assert.equal(out.reason, "error");
  assert.deepEqual(marked, [], "not stamped, so a later backfill can retry it");
});
