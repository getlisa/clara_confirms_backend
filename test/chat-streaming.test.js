/**
 * The confirmation chat streams real model tokens.
 *
 * Before this, POST /chat-links/:token/messages awaited the ENTIRE turn — LLM
 * round-trips plus every tool call — and only then sliced the finished text
 * into 12-character `message_delta` ticks. The SSE wire protocol looked like
 * streaming; the customer stared at a typing dot for the whole turn and then
 * watched a fake typewriter replay text that had already existed for seconds.
 *
 * Now the deltas come from `graph.streamEvents` as the model generates them.
 * The wire protocol is deliberately IDENTICAL (typing → message_delta* →
 * message_complete → done) so the frontend needs no change.
 *
 * Two failure modes are worth more than the feature itself and are pinned
 * hardest:
 *
 *   1. Double rendering. `sendChatMessage` still RETURNS the turn's messages.
 *      A route that streams via onEvent *and* loops the return value sends
 *      every reply twice.
 *   2. Silent divergence. What is streamed must equal what a later
 *      GET /chat-links/:token replay shows. A message that streams but never
 *      persists — or persists but never streams — is invisible in one of the
 *      two views of the same conversation.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [{ job_ref: "J1", customer_ref: "C1", customer_email: null, customer_phone: null }] }) });
stub("db/chat-links", { setStateByToken: async () => {} });
stub("services/servicetrade-comments", { postConfirmationAgentComment: async () => {} });
stub("confirmation-agent/tools/confirmer-label", { resolveContact: async () => null });

// ── A graph whose streamEvents replays a scripted event list ────────────────
// Shapes copied from what LangGraph v2 actually emits: on_chat_model_stream
// carries an AIMessageChunk, on_chat_model_end an AIMessage (or an LLMResult),
// on_tool_end a ToolMessage-ish object with a JSON string `content`.

let SCRIPT = [];
let finalMessages = [];
const invokeCalls = [];
const streamCalls = [];

const fakeGraph = {
  async getState() { return { values: { messages: finalMessages } }; },
  async invoke(input, config) { invokeCalls.push({ input, config }); },
  async *streamEvents(input, config) {
    streamCalls.push({ input, config });
    for (const ev of SCRIPT) yield ev;
  },
};
stub("confirmation-agent/graph/build", { getGraph: async () => fakeGraph, phaseFromContext: () => "confirming" });

const confirmationAgent = require("../src/confirmation-agent");

const aiChunk = (text) => ({ event: "on_chat_model_stream", data: { chunk: { content: text } } });
const aiEnd = (text, tool_calls = []) => ({ event: "on_chat_model_end", data: { output: { content: text, tool_calls } } });
const toolEnd = (name, payload) => ({ event: "on_tool_end", name, data: { output: { content: JSON.stringify(payload) } } });

const OPTS = { companyId: 9, jobId: 77, token: "tok-1", companyName: "Acme" };

function collect() {
  const events = [];
  return { events, onEvent: (ev) => { events.push(ev); } };
}

function reset(script, final = []) {
  SCRIPT = script;
  finalMessages = final;
  invokeCalls.length = 0;
  streamCalls.length = 0;
  logger.reset();
}

// ── Tokens actually stream ──────────────────────────────────────────────────

test("deltas are emitted as generated, then the completed message", async () => {
  reset([aiChunk("Hi "), aiChunk("Dana"), aiChunk("!"), aiEnd("Hi Dana!")]);
  const { events, onEvent } = collect();

  await confirmationAgent.sendMessage({ ...OPTS, content: "hello" }, onEvent);

  assert.deepEqual(events.map((e) => e.type), ["delta", "delta", "delta", "message"]);
  assert.deepEqual(events.slice(0, 3).map((e) => e.chunk), ["Hi ", "Dana", "!"]);
  assert.equal(events[3].message.content, "Hi Dana!",
    "the completed message must carry exactly what the deltas spelled out");
  assert.equal(events[3].message.role, "agent");
});

test("the chunks concatenate to the completed text — no dropped or doubled token", async () => {
  reset([aiChunk("You"), aiChunk("'re all"), aiChunk(" set."), aiEnd("You're all set.")]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "yes" }, onEvent);

  const streamed = events.filter((e) => e.type === "delta").map((e) => e.chunk).join("");
  const completed = events.find((e) => e.type === "message").message.content;
  assert.equal(streamed, completed);
});

test("streaming drives the graph through streamEvents, not invoke", async () => {
  reset([aiEnd("ok")]);
  await confirmationAgent.sendMessage({ ...OPTS, content: "hi" }, collect().onEvent);
  assert.equal(streamCalls.length, 1);
  assert.equal(invokeCalls.length, 0);
  assert.equal(streamCalls[0].config.version, "v2",
    "v1 event names differ — the pump would silently emit nothing");
  assert.equal(streamCalls[0].config.configurable.thread_id, "tok-1");
});

test("without an onEvent callback the old invoke path is used unchanged", async () => {
  reset([aiChunk("x"), aiEnd("x")]);
  const { messages } = await confirmationAgent.sendMessage({ ...OPTS, content: "hi" });
  assert.equal(invokeCalls.length, 1);
  assert.equal(streamCalls.length, 0, "a non-streaming caller must not pay for callback plumbing");
  assert.deepEqual(messages, []);
});

// ── Shape tolerance ─────────────────────────────────────────────────────────

test("a content-array chunk streams its text parts", async () => {
  reset([
    { event: "on_chat_model_stream", data: { chunk: { content: [{ type: "text", text: "Sure" }] } } },
    aiEnd("Sure"),
  ]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "hi" }, onEvent);
  assert.equal(events[0].chunk, "Sure");
});

test("an LLMResult-wrapped end still yields the completed message", async () => {
  // Some provider integrations hand back generations rather than the message.
  reset([{ event: "on_chat_model_end", data: { output: { generations: [[{ message: { content: "Done." } }]] } } }]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "hi" }, onEvent);
  assert.deepEqual(events.map((e) => e.type), ["message"]);
  assert.equal(events[0].message.content, "Done.");
});

// ── Noise that must not reach the customer ──────────────────────────────────

test("a pure tool-call generation emits no empty message", async () => {
  reset([aiEnd("", [{ name: "confirm_appointment", id: "c1", args: {} }]), aiChunk("Confirmed."), aiEnd("Confirmed.")]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "yes" }, onEvent);

  assert.deepEqual(events.map((e) => e.type), ["delta", "message"],
    "an empty bubble would render as a blank message in the transcript");
});

test("empty deltas are never sent", async () => {
  reset([aiChunk(""), aiChunk("Hi"), aiChunk(""), aiEnd("Hi")]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "hi" }, onEvent);
  assert.equal(events.filter((e) => e.type === "delta").length, 1);
});

test("text alongside tool calls still streams — the replay will show it", async () => {
  // toVisibleMessages has always included tool-calling generations' text.
  // Dropping it here would make the live view and the replay disagree.
  reset([aiChunk("Let me check."), aiEnd("Let me check.", [{ name: "confirm_appointment", id: "c1", args: {} }])]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "yes" }, onEvent);
  assert.equal(events.filter((e) => e.type === "message").length, 1);
});

// ── Service links keep their structured shape, in order ─────────────────────

test("a successful get_service_link streams as a service_link message in place", async () => {
  reset([
    aiChunk("One sec."), aiEnd("One sec.", [{ name: "get_service_link", id: "t1", args: {} }]),
    toolEnd("get_service_link", { success: true, url: "https://app.servicetrade.com/x", job_name: "Quarterly PM" }),
    aiChunk("Sent!"), aiEnd("Sent!"),
  ]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "email it" }, onEvent);

  const messages = events.filter((e) => e.type === "message").map((e) => e.message);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].type, "service_link", "the link must land between the two replies, not after both");
  assert.equal(messages[1].url, "https://app.servicetrade.com/x");
  assert.equal(messages[1].job_name, "Quarterly PM");
});

test("a failed get_service_link streams no link", async () => {
  reset([toolEnd("get_service_link", { success: false, error: "no contact" }), aiEnd("I could not send it.")]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "email it" }, onEvent);
  assert.equal(events.filter((e) => e.message?.type === "service_link").length, 0);
});

test("other tools stream nothing of their own", async () => {
  reset([toolEnd("confirm_appointment", { success: true, appointment_id: 12 }), aiEnd("Confirmed.")]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "yes" }, onEvent);
  assert.deepEqual(events.map((e) => e.type), ["message"],
    "raw tool plumbing must stay out of the customer's transcript");
});

test("unparseable tool output does not break the stream", async () => {
  reset([
    { event: "on_tool_end", name: "get_service_link", data: { output: { content: "<html>502</html>" } } },
    aiEnd("Sorry about that."),
  ]);
  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "email it" }, onEvent);
  assert.equal(events.length, 1);
  assert.equal(events[0].message.content, "Sorry about that.");
});

// ── The live stream and the persisted transcript agree ──────────────────────

test("streamed messages match what the transcript replay will show", async () => {
  const persisted = [
    { type: "human", content: "email it" },
    { type: "ai", content: "One sec.", tool_calls: [{ name: "get_service_link", id: "t1", args: {} }] },
    { type: "tool", name: "get_service_link", tool_call_id: "t1", content: JSON.stringify({ success: true, url: "https://app.servicetrade.com/x", job_name: "PM" }) },
    { type: "ai", content: "Sent!", tool_calls: [] },
  ];
  reset([
    aiChunk("One sec."), aiEnd("One sec.", [{ name: "get_service_link", id: "t1", args: {} }]),
    toolEnd("get_service_link", { success: true, url: "https://app.servicetrade.com/x", job_name: "PM" }),
    aiChunk("Sent!"), aiEnd("Sent!"),
  ], persisted);

  const { events, onEvent } = collect();
  await confirmationAgent.sendMessage({ ...OPTS, content: "email it" }, onEvent);

  const streamed = events.filter((e) => e.type === "message").map((e) => e.message);
  assert.deepEqual(
    streamed.map((m) => (m.type === "service_link" ? `link:${m.url}` : m.content)),
    ["One sec.", "link:https://app.servicetrade.com/x", "Sent!"],
    "same messages, same order, as toVisibleMessages produces from the checkpoint"
  );
  assert.ok(streamed.every((m) => m.role === "agent"),
    "the customer's own message must never be echoed back — the frontend already rendered it");
});

// ── The route: exactly one copy of each reply ───────────────────────────────
// The router captures `chatLinksService` at require time, so the stub has to
// be a stable object with a swappable implementation — re-stubbing the module
// later would replace require.cache but not the reference the router holds,
// and every route test would silently run against the FIRST test's fake.

let routeImpl = async () => ({ ok: true, messages: [], state: "open", input_hint: null });
stub("services/chat-links", { sendChatMessage: (...args) => routeImpl(...args) });
const chatLinksRouter = require("../src/routes/chat-links");

async function startRouteServer() {
  const router = chatLinksRouter;
  const app = express();
  app.use(express.json());
  app.use("/chat-links", router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  return server;
}

test("the SSE route sends each reply exactly once", async () => {
  // Stub the service so the route's own emission logic is what's under test.
  routeImpl = async (_token, _content, onEvent) => {
    await onEvent({ type: "delta", chunk: "Hi " });
    await onEvent({ type: "delta", chunk: "Dana!" });
    await onEvent({ type: "message", message: { role: "agent", content: "Hi Dana!", created_at: null } });
    // Returned as well — the pre-streaming route rendered THIS, so a route
    // that forgot to stop would now duplicate every reply.
    return { ok: true, messages: [{ role: "agent", content: "Hi Dana!" }], state: "chat_ended", input_hint: null };
  };
  const server = await startRouteServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat-links/tok-1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "hello" }),
    });
    const body = await res.text();

    const names = body.split("\n\n").filter((b) => b.startsWith("event:")).map((b) => b.match(/^event: (\w+)/)[1]);
    assert.deepEqual(names, ["typing", "message_delta", "message_delta", "message_complete", "done"]);
    assert.equal((body.match(/event: message_complete/g) || []).length, 1,
      "the returned messages must not be rendered on top of the streamed ones");
    assert.match(body, /"chunk":"Hi "/);
    assert.match(body, /"state":"chat_ended"/);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.equal(res.headers.get("x-accel-buffering"), "no", "or a proxy holds every delta to the end");
  } finally {
    server.close();
  }
});

test("the done event reports time to first token", async () => {
  routeImpl = async (_token, _content, onEvent) => {
    await new Promise((r) => setTimeout(r, 40));
    await onEvent({ type: "delta", chunk: "Hi" });
    await new Promise((r) => setTimeout(r, 40));
    await onEvent({ type: "message", message: { role: "agent", content: "Hi", created_at: null } });
    return { ok: true, messages: [], state: "open", input_hint: null };
  };
  const server = await startRouteServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat-links/tok-1/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi" }),
    });
    const done = JSON.parse((await res.text()).match(/event: done\ndata: (.+)/)[1]);
    assert.ok(done.first_token_ms >= 40, "must be measured from the request, not from the first delta");
    assert.ok(done.total_ms >= done.first_token_ms,
      "first token must precede completion — inverted timings would make the metric meaningless");
  } finally {
    server.close();
  }
});

test("a turn that produces no text reports a null first-token time, not zero", async () => {
  routeImpl = async () => ({ ok: true, messages: [], state: "chat_ended", input_hint: null });
  const server = await startRouteServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat-links/tok-1/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi" }),
    });
    const done = JSON.parse((await res.text()).match(/event: done\ndata: (.+)/)[1]);
    assert.equal(done.first_token_ms, null, "0 would read as an instant reply in the logs");
  } finally {
    server.close();
  }
});

test("a service error is reported as an error event, not a silent hang", async () => {
  routeImpl = async () => ({ ok: false, status: 404, error: "Chat link not found or expired" });
  const server = await startRouteServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat-links/tok-1/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi" }),
    });
    const body = await res.text();
    assert.match(body, /event: error/);
    assert.doesNotMatch(body, /event: done/);
  } finally {
    server.close();
  }
});

test("a mid-stream throw still closes the stream with an error", async () => {
  routeImpl = async (_t, _c, onEvent) => {
    await onEvent({ type: "delta", chunk: "Hi" });
    throw new Error("both providers failed");
  };
  const server = await startRouteServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat-links/tok-1/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "hi" }),
    });
    const body = await res.text();
    assert.match(body, /event: message_delta/, "already-streamed text is not retracted");
    assert.match(body, /event: error/);
  } finally {
    server.close();
  }
});

test("the route rejects an empty message before opening a stream", async () => {
  const server = await startRouteServer();
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/chat-links/tok-1/messages`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "   " }),
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type"), /application\/json/);
  } finally {
    server.close();
  }
});
