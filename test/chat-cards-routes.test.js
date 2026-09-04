/**
 * Every card action (confirm/reschedule/cancel/confirm_job_appointments/
 * decline_remaining_appointments/send_service_link) now goes through the
 * SAME endpoint as free chat — `POST /:token/messages` with
 * `{ trigger, args }` — instead of six separate URLs. The route dispatches a
 * card-trigger `trigger` to handleCardTriggerMessage, which resolves the
 * token/validates `args` as plain JSON (before any SSE stream opens) and
 * then runs the SAME mechanism the old per-route handlers used: a
 * card-trigger marker sent through the agent
 * (chatLinksService.sendChatMessage), structurally forcing the model to call
 * exactly one tool (registry.js's exclusiveTool + model.js's tool_choice).
 * The write itself is unchanged (the promoted tool handlers call the same
 * actions.js core functions) — what changed is that there is no longer a URL
 * per action, reschedule's "skip, no date given" case is no longer a
 * route-level branch (it's now inside the reschedule_appointment tool
 * handler itself — see reschedule-appointment-optional-date.test.js), and
 * `send_service_link` runs TWO forced tool turns in sequence
 * (resolve_service_link_contact, then get_service_link) within one response
 * — the one trigger whose happy-path shape is 7 events, not 4.
 *
 * This file stubs `services/chat-links`'s sendChatMessage to simulate
 * whatever the agent would produce — there is no real model, no real graph,
 * anywhere in this file. The determinism-specific tests exist because a
 * model in the loop CAN misbehave (stray narration, no tool call, the wrong
 * tool) even when everything upstream is configured correctly — the routes
 * must guarantee the customer-visible response never varies in shape
 * regardless.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);
stub("db", { query: async () => ({ rows: [{ job_ref: "J1", customer_ref: "C1" }] }) });

let linkRow = { id: 1, token: "valid-token", company_id: 8, job_id: 900, recipient_contact_id: null, recipient_name: "Dana" };
stub("db/chat-links", { getByToken: async (token) => (token === linkRow.token ? linkRow : null) });

let ctxResult = { ok: true, job: { id: 900, job_number: "1", title: "J", location_name: "Site" }, appointments: { upcoming: [] }, counts: { unconfirmed: 0, all_confirmed: true } };
stub("services/job-confirmation-context", { buildJobConfirmationContext: async () => ctxResult });

// A trivial, test-owned marker format — the route only cares that
// buildCardTrigger produces SOME string it can hand to sendChatMessage and
// that the tool name can be recovered from it; the real prefix format is
// actions.js's own concern, tested in actions.test.js / index.js's tests.
const TRIGGER_PREFIX = "TRIGGER:";
stub("confirmation-agent/actions", {
  buildCardTrigger: (tool) => `${TRIGGER_PREFIX}${tool}`,
});

// Simulates the agent turn a card-trigger call drives via
// chatLinksService.sendChatMessage(token, content, onEvent, cardTriggerArgs).
// `impls` lets each test control exactly what the "model" does this turn.
const sendChatMessageCalls = [];
let impls = {};
async function sendChatMessageImpl(token, content, onEvent, cardTriggerArgs) {
  sendChatMessageCalls.push({ token, content, cardTriggerArgs });
  if (impls.sendChatMessage) return impls.sendChatMessage({ token, content, onEvent, cardTriggerArgs });

  const tool = content.startsWith(TRIGGER_PREFIX) ? content.slice(TRIGGER_PREFIX.length) : null;

  // A model that narrates despite instructions — these must never reach the
  // customer-visible SSE stream (guardrail: only tool_call/tool_result do).
  if (impls.strayNarration) {
    onEvent?.({ type: "delta", chunk: "Sure, confirming now..." });
    onEvent?.({ type: "message", message: { role: "agent", content: "Sure, confirming now...", created_at: null } });
  }

  if (!impls.noToolCall) {
    const calledTool = impls.wrongTool || tool;
    onEvent?.({ type: "tool_call", tool: calledTool, args: cardTriggerArgs });
    if (!impls.noToolResult) {
      const result = impls.result ? impls.result() : { success: true, ...cardTriggerArgs };
      onEvent?.({ type: "tool_result", tool: calledTool, result });
    }
  }
  // The real sendChatMessage computes fresh cards AFTER the write, straight
  // off its own post-write buildJobConfirmationContext call — the route no
  // longer calls a separate freshCards() to get these (that was the
  // redundant, now-removed second context build). ctxResult.appointments.upcoming
  // is always [] in this file, so appointments mirrors that constant.
  return {
    ok: true,
    appointments: [],
    remaining_unconfirmed: ctxResult.ok ? ctxResult.counts.unconfirmed : null,
    all_confirmed: ctxResult.ok ? ctxResult.counts.all_confirmed : null,
  };
}
stub("services/chat-links", { sendChatMessage: (...args) => sendChatMessageImpl(...args) });

const finalizeCalls = [];
stub("confirmation-agent", {
  finalizeConversation: async (threadId, ctx) => { finalizeCalls.push({ threadId, ctx }); },
  resolveRecipient: async (companyId, recipientContactId, customerEmail, customerPhone, snapshot) => ({
    recipientName: snapshot?.name ?? null,
    recipientEmail: snapshot?.email ?? customerEmail ?? null,
    recipientPhone: snapshot?.phone ?? customerPhone ?? null,
  }),
  resolveConfirmedBy: async () => null,
});

const router = require("../src/routes/chat-links");

function reset() {
  sendChatMessageCalls.length = 0; finalizeCalls.length = 0; impls = {};
  linkRow = { id: 1, token: "valid-token", company_id: 8, job_id: 900, recipient_contact_id: null, recipient_name: "Dana" };
  ctxResult = { ok: true, job: { id: 900, job_number: "1", title: "J", location_name: "Site" }, appointments: { upcoming: [] }, counts: { unconfirmed: 0, all_confirmed: true } };
  logger.reset();
}

let server, base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/chat-links", router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/chat-links`;
});
test.after(() => server.close());

/**
 * Posts and returns either `{status, json}` (a plain response — a trigger
 * call still 404/400s in plain JSON for anything caught BEFORE the SSE
 * stream opens: unknown token, missing required args) or `{status, events}`
 * (an SSE response, parsed into `{event, data}` entries in wire order).
 */
async function post(path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const events = text.split("\n\n").map((b) => b.trim()).filter(Boolean)
      .map((block) => {
        const lines = block.split("\n");
        const eventLine = lines.find((l) => l.startsWith("event:"));
        const dataLine = lines.find((l) => l.startsWith("data:"));
        if (!eventLine) return null; // a heartbeat comment line — never expected in these fast tests, filtered defensively
        return { event: eventLine.slice("event:".length).trim(), data: JSON.parse(dataLine.slice("data:".length).trim()) };
      })
      .filter(Boolean);
    return { status: res.status, events };
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function trigger(token, trig, args) {
  return post(`/${token}/messages`, { trigger: trig, args });
}

// ── Unknown token — every card-action trigger the same way, still plain JSON ─

test("an unknown token 404s on every card-action trigger, before any SSE stream opens", async () => {
  reset();
  for (const [trig, args] of [
    ["confirm_appointment", { appointment_id: 1 }],
    ["reschedule_appointment", { appointment_id: 1 }],
    ["cancel_appointment", { appointment_id: 1, reason: "x" }],
    ["confirm_job_appointments", { confirm_all: true }],
    ["decline_remaining_appointments", {}],
    ["send_service_link", { email: "a@b.com" }],
    ["capture_confirmer_identity", { first_name: "A", last_name: "B", role: "owner", phone: "+15551234567" }],
  ]) {
    const { status, json } = await trigger("bad-token", trig, args);
    assert.equal(status, 404);
    assert.equal(json.error, "Chat link not found");
  }
  for (const [path, body] of [
    ["/bad-token/end"],
  ]) {
    const { status, json } = await post(path, body);
    assert.equal(status, 404);
    assert.equal(json.error, "Chat link not found");
  }
  assert.equal(sendChatMessageCalls.length, 0, "no agent turn should ever run for an unresolvable token");
});

// ── trigger: confirm_appointment ────────────────────────────────────────────

test("confirm_appointment: streams thinking → tool_call → tool_result → done, with fresh cards", async () => {
  reset();
  const { status, events } = await trigger("valid-token", "confirm_appointment", { appointment_id: 501 });
  assert.equal(status, 200);
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "done"]);
  assert.equal(events[1].data.tool, "confirm_appointment");
  assert.deepEqual(events[1].data.args, { appointment_id: 501 });
  assert.equal(events[2].data.result.success, true);
  assert.deepEqual(events[3].data.appointments, []);
  assert.equal(events[3].data.needs_propose_remaining, false);
  assert.equal(sendChatMessageCalls[0].cardTriggerArgs.appointment_id, 501);
});

test("confirm_appointment: needs_propose_remaining is true when other appointments are still unconfirmed", async () => {
  reset();
  ctxResult = { ...ctxResult, counts: { unconfirmed: 2, all_confirmed: false } };
  const { events } = await trigger("valid-token", "confirm_appointment", { appointment_id: 501 });
  const done = events.find((e) => e.event === "done");
  assert.equal(done.data.needs_propose_remaining, true);
});

test("confirm_appointment: appointment_id is required — 400 before any SSE stream opens", async () => {
  reset();
  const { status, json } = await trigger("valid-token", "confirm_appointment", {});
  assert.equal(status, 400);
  assert.match(json.error, /appointment_id/i);
  assert.equal(sendChatMessageCalls.length, 0);
});

test("confirm_appointment: a failed tool result surfaces as an `error` event, not `done`", async () => {
  reset();
  impls.result = () => ({ success: false, error: "Appointment not found" });
  const { events } = await trigger("valid-token", "confirm_appointment", { appointment_id: 999 });
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "error"]);
  assert.equal(events[3].data.error, "Appointment not found");
});

// ── Determinism guardrails — apply identically to every trigger, exercised
// once here on confirm_appointment ──────────────────────────────────────────

test("determinism: stray delta/message events from the model never reach the wire", async () => {
  reset();
  impls.strayNarration = true;
  const { events } = await trigger("valid-token", "confirm_appointment", { appointment_id: 501 });
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "done"],
    "delta/message must never appear here, even if the model produced them");
});

test("determinism: a tool_call for the wrong tool surfaces as an error", async () => {
  reset();
  impls.wrongTool = "cancel_appointment";
  const { events } = await trigger("valid-token", "confirm_appointment", { appointment_id: 501 });
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "error"]);
});

test("determinism: no tool_call at all surfaces as an error, not a hung or empty done", async () => {
  reset();
  impls.noToolCall = true;
  const { events } = await trigger("valid-token", "confirm_appointment", { appointment_id: 501 });
  assert.deepEqual(events.map((e) => e.event), ["thinking", "error"]);
});

test("determinism: a tool_call with no matching tool_result surfaces as an error", async () => {
  reset();
  impls.noToolResult = true;
  const { events } = await trigger("valid-token", "confirm_appointment", { appointment_id: 501 });
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "error"]);
});

// ── trigger: reschedule_appointment ─────────────────────────────────────────
// Both the "picked a time" and "skip" branches are now the SAME trigger over
// the SAME endpoint — the branch lives inside the tool handler (see
// reschedule-appointment-optional-date.test.js), so the route treats them
// identically and always streams the full four-event shape.

test("reschedule_appointment: with a date/time, streams a real reschedule turn", async () => {
  reset();
  const { status, events } = await trigger("valid-token", "reschedule_appointment", { appointment_id: 501, scheduled_start: "2026-09-01T14:00:00" });
  assert.equal(status, 200);
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "done"]);
  assert.equal(events[1].data.tool, "reschedule_appointment");
  assert.deepEqual(sendChatMessageCalls[0].cardTriggerArgs, { appointment_id: 501, scheduled_start: "2026-09-01T14:00:00" });
});

test("reschedule_appointment: needs_propose_remaining reflects remaining_unconfirmed after a real reschedule", async () => {
  reset();
  ctxResult = { ...ctxResult, counts: { unconfirmed: 1, all_confirmed: false } };
  const { events } = await trigger("valid-token", "reschedule_appointment", { appointment_id: 501, scheduled_start: "2026-09-01T14:00:00" });
  assert.equal(events.find((e) => e.event === "done").data.needs_propose_remaining, true);
});

test("reschedule_appointment: appointment_id is required — 400 before any SSE stream opens", async () => {
  reset();
  const { status, json } = await trigger("valid-token", "reschedule_appointment", {});
  assert.equal(status, 400);
  assert.match(json.error, /appointment_id/i);
  assert.equal(sendChatMessageCalls.length, 0);
});

test("reschedule_appointment: with NO date/time, still streams the same four-event shape — the escalation happens inside the tool call", async () => {
  reset();
  ctxResult = { ...ctxResult, counts: { unconfirmed: 1, all_confirmed: false } };
  impls.result = () => ({ success: true, escalated: true, appointment_id: 501, message: "Our team will follow up to find a time." });
  const { status, events } = await trigger("valid-token", "reschedule_appointment", { appointment_id: 501 });
  assert.equal(status, 200);
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "done"]);
  assert.equal(events[2].data.result.escalated, true);
  assert.equal(events.find((e) => e.event === "done").data.needs_propose_remaining, true, "escalating still leaves other appointments to ask about");
  // scheduled_start must not even be present when omitted — never sent as
  // undefined/null, which the tool handler would have to distinguish from
  // "the model explicitly cleared it."
  assert.ok(!("scheduled_start" in sendChatMessageCalls[0].cardTriggerArgs));
});

// ── trigger: cancel_appointment ──────────────────────────────────────────────

test("cancel_appointment: reason is required for a workflow that doesn't relax it (ServiceTrade) — 400 before any SSE stream", async () => {
  // The token IS resolved before this check now (needed to look up the
  // company's workflow and decide whether reason is even required — see
  // handleCardTriggerMessage) — but the resolution itself never touches the
  // graph/SSE, so the observable contract (400, no chat message sent) is
  // unchanged from when this ran purely off request args.
  reset();
  const { status, json } = await trigger("valid-token", "cancel_appointment", { appointment_id: 501 });
  assert.equal(status, 400);
  assert.match(json.error, /reason/i);
  assert.equal(sendChatMessageCalls.length, 0);
});

test("cancel_appointment: appointment_id is required — 400 before any SSE stream opens", async () => {
  reset();
  const { status, json } = await trigger("valid-token", "cancel_appointment", { reason: "no longer needed" });
  assert.equal(status, 400);
  assert.match(json.error, /appointment_id/i);
});

test("cancel_appointment: defaults scope to appointment_only when not given", async () => {
  reset();
  const { status, events } = await trigger("valid-token", "cancel_appointment", { appointment_id: 501, reason: "no longer needed" });
  assert.equal(status, 200);
  assert.equal(sendChatMessageCalls[0].cardTriggerArgs.scope, "appointment_only");
  assert.equal(events[1].data.tool, "cancel_appointment");
});

test("cancel_appointment: entire_job scope is passed through", async () => {
  reset();
  await trigger("valid-token", "cancel_appointment", { appointment_id: 501, reason: "x", scope: "entire_job" });
  assert.equal(sendChatMessageCalls[0].cardTriggerArgs.scope, "entire_job");
});

test("cancel_appointment: done has no needs_propose_remaining — cancel closes the chat, nothing to propose", async () => {
  reset();
  ctxResult = { ...ctxResult, counts: { unconfirmed: 1, all_confirmed: false } };
  const { events } = await trigger("valid-token", "cancel_appointment", { appointment_id: 501, reason: "x" });
  assert.equal(events.find((e) => e.event === "done").data.needs_propose_remaining, undefined);
});

// ── trigger: confirm_job_appointments (formerly bulk-confirm) ───────────────

test("confirm_job_appointments: confirm_all=true is forwarded as the real, request-known args", async () => {
  reset();
  impls.result = () => ({ success: true, confirmed: [501, 502], skipped: [], job_status: "confirmed" });
  const { status, events } = await trigger("valid-token", "confirm_job_appointments", { confirm_all: true });
  assert.equal(status, 200);
  assert.equal(sendChatMessageCalls[0].cardTriggerArgs.confirm_all, true);
  assert.deepEqual(events.find((e) => e.event === "tool_result").data.result.confirmed, [501, 502]);
  assert.equal(events[1].data.tool, "confirm_job_appointments");
});

test("confirm_job_appointments: needs_propose_remaining is included", async () => {
  reset();
  ctxResult = { ...ctxResult, counts: { unconfirmed: 1, all_confirmed: false } };
  const { events } = await trigger("valid-token", "confirm_job_appointments", { confirm_all: true });
  assert.equal(events.find((e) => e.event === "done").data.needs_propose_remaining, true);
});

test("confirm_job_appointments: succeeds (and still emits done) even when nothing got confirmed — the call itself IS the customer's answer to 'confirm the rest?'", async () => {
  reset();
  impls.result = () => ({ success: true, confirmed: [], skipped: [{ appointment_id: "1", reason: "already_confirmed" }], job_status: "confirmed" });
  const { events } = await trigger("valid-token", "confirm_job_appointments", { appointment_ids: ["1"] });
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "done"]);
});

test("confirm_job_appointments: neither confirm_all nor appointment_ids given surfaces as a tool_result-driven error, not a pre-stream 400", async () => {
  reset();
  impls.result = () => ({ success: false, error: "Pass confirmAll=true or a non-empty appointmentIds list" });
  const { events } = await trigger("valid-token", "confirm_job_appointments", {});
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "error"]);
});

// ── trigger: decline_remaining_appointments ─────────────────────────────────

test("decline_remaining_appointments: streams a real turn, returns fresh cards, no needs_propose_remaining", async () => {
  reset();
  const { status, events } = await trigger("valid-token", "decline_remaining_appointments", {});
  assert.equal(status, 200);
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "done"]);
  assert.equal(events[1].data.tool, "decline_remaining_appointments");
  assert.deepEqual(events.find((e) => e.event === "done").data.appointments, []);
  assert.equal(events.find((e) => e.event === "done").data.needs_propose_remaining, undefined);
});

// ── trigger: capture_confirmer_identity ──────────────────────────────────────

test("capture_confirmer_identity: streams a real turn with the request's own args, not a chat one", async () => {
  reset();
  impls.result = () => ({ success: true, first_name: "Jane", last_name: "Doe", role: "on_site", phone: "+15551234567", email: null });
  const { status, events } = await trigger("valid-token", "capture_confirmer_identity", {
    first_name: "Jane", last_name: "Doe", role: "on_site", phone: "+15551234567",
  });
  assert.equal(status, 200);
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "done"]);
  assert.equal(events[1].data.tool, "capture_confirmer_identity");
  assert.deepEqual(sendChatMessageCalls[0].cardTriggerArgs, {
    first_name: "Jane", last_name: "Doe", role: "on_site", phone: "+15551234567", email: null,
  });
  assert.equal(events.find((e) => e.event === "done").data.needs_propose_remaining, undefined);
});

test("capture_confirmer_identity: first_name is required — 400 before any SSE stream opens", async () => {
  reset();
  const { status, json } = await trigger("valid-token", "capture_confirmer_identity", { last_name: "Doe", role: "on_site", phone: "+15551234567" });
  assert.equal(status, 400);
  assert.match(json.error, /first_name/i);
});

test("capture_confirmer_identity: last_name is required — 400 before any SSE stream opens", async () => {
  reset();
  const { status, json } = await trigger("valid-token", "capture_confirmer_identity", { first_name: "Jane", role: "on_site", phone: "+15551234567" });
  assert.equal(status, 400);
  assert.match(json.error, /last_name/i);
});

test("capture_confirmer_identity: role must be one of the closed enum values — 400 before any SSE stream opens", async () => {
  reset();
  const { status, json } = await trigger("valid-token", "capture_confirmer_identity", { first_name: "Jane", last_name: "Doe", role: "ceo", phone: "+15551234567" });
  assert.equal(status, 400);
  assert.match(json.error, /role/i);
});

test("capture_confirmer_identity: phone is required — 400 before any SSE stream opens", async () => {
  reset();
  const { status, json } = await trigger("valid-token", "capture_confirmer_identity", { first_name: "Jane", last_name: "Doe", role: "on_site" });
  assert.equal(status, 400);
  assert.match(json.error, /phone/i);
});

test("capture_confirmer_identity: email defaults to null when omitted", async () => {
  reset();
  await trigger("valid-token", "capture_confirmer_identity", { first_name: "Jane", last_name: "Doe", role: "on_site", phone: "+15551234567" });
  assert.equal(sendChatMessageCalls[0].cardTriggerArgs.email, null);
});

// ── trigger: send_service_link ───────────────────────────────────────────────
// The one composite trigger: forces resolve_service_link_contact, then —
// only if it actually resolved a contact (found/created, not need_more_info)
// — forces get_service_link too, within the SAME SSE response. Its own
// `impls.sendChatMessage` override is used throughout (rather than the
// shared default path) since each test needs different behavior per which
// of the two internal tool calls is running.

test("send_service_link: full success streams both steps, then done with fresh cards", async () => {
  reset();
  let calls = 0;
  impls.sendChatMessage = async ({ content, onEvent }) => {
    calls++;
    const tool = content.slice(TRIGGER_PREFIX.length);
    if (tool === "resolve_service_link_contact") {
      onEvent({ type: "tool_call", tool, args: { email: "dana@x.test", email_confirmed: true } });
      onEvent({ type: "tool_result", tool, result: { success: true, status: "found", contact_id: "55", name: "Dana Acme", email: "dana@x.test", link_sent: true } });
    } else {
      onEvent({ type: "tool_call", tool, args: {} });
      onEvent({ type: "tool_result", tool, result: { success: true, url: "https://app.servicetrade.com/x", job_name: "Quarterly PM" } });
    }
    return { ok: true, appointments: [], remaining_unconfirmed: 0, all_confirmed: true };
  };
  const { status, events } = await trigger("valid-token", "send_service_link", { email: "dana@x.test" });
  assert.equal(status, 200);
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "thinking", "tool_call", "tool_result", "done"]);
  assert.equal(events[1].data.tool, "resolve_service_link_contact");
  assert.equal(events[2].data.result.status, "found");
  assert.equal(events[4].data.tool, "get_service_link");
  assert.equal(events[5].data.result.url, "https://app.servicetrade.com/x");
  assert.equal(events[6].data.needs_propose_remaining, undefined, "sending a link doesn't touch confirmation state");
  assert.equal(calls, 2, "both steps must run exactly once");
});

test("send_service_link: need_more_info stops after step 1 — get_service_link never runs", async () => {
  reset();
  let calls = 0;
  impls.sendChatMessage = async ({ content, onEvent }) => {
    calls++;
    const tool = content.slice(TRIGGER_PREFIX.length);
    onEvent({ type: "tool_call", tool, args: {} });
    onEvent({ type: "tool_result", tool, result: { success: true, status: "need_more_info", email: "dana@x.test", fields_needed: ["first_name", "last_name"] } });
    return { ok: true, appointments: [], remaining_unconfirmed: 0, all_confirmed: true };
  };
  const { status, events } = await trigger("valid-token", "send_service_link", { email: "dana@x.test" });
  assert.equal(status, 200);
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "done"]);
  assert.equal(events[2].data.result.status, "need_more_info");
  assert.deepEqual(events[2].data.result.fields_needed, ["first_name", "last_name"]);
  assert.equal(calls, 1, "get_service_link must never be called when step 1 needs more info");
});

test("send_service_link: step 1 failing outright surfaces error, never reaches step 2", async () => {
  reset();
  let calls = 0;
  impls.sendChatMessage = async ({ content, onEvent }) => {
    calls++;
    const tool = content.slice(TRIGGER_PREFIX.length);
    onEvent({ type: "tool_call", tool, args: {} });
    onEvent({ type: "tool_result", tool, result: { success: false, error: "Failed to create contact in ServiceTrade" } });
    return { ok: true, appointments: [], remaining_unconfirmed: 0, all_confirmed: true };
  };
  const { events } = await trigger("valid-token", "send_service_link", { email: "dana@x.test" });
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "error"]);
  assert.equal(events[3].data.error, "Failed to create contact in ServiceTrade");
  assert.equal(calls, 1);
});

test("send_service_link: step 2 failing after a successful step 1 surfaces error", async () => {
  reset();
  impls.sendChatMessage = async ({ content, onEvent }) => {
    const tool = content.slice(TRIGGER_PREFIX.length);
    onEvent({ type: "tool_call", tool, args: {} });
    if (tool === "resolve_service_link_contact") {
      onEvent({ type: "tool_result", tool, result: { success: true, status: "found", contact_id: "55", name: "Dana", email: "dana@x.test", link_sent: false } });
    } else {
      onEvent({ type: "tool_result", tool, result: { success: false, error: "No ServiceTrade job found for this conversation" } });
    }
    return { ok: true, appointments: [], remaining_unconfirmed: 0, all_confirmed: true };
  };
  const { events } = await trigger("valid-token", "send_service_link", { email: "dana@x.test" });
  assert.deepEqual(events.map((e) => e.event), ["thinking", "tool_call", "tool_result", "thinking", "tool_call", "tool_result", "error"]);
  assert.equal(events[6].data.error, "No ServiceTrade job found for this conversation");
});

test("send_service_link: forces email_confirmed=true and passes through optional name fields", async () => {
  reset();
  impls.sendChatMessage = async ({ content, onEvent, cardTriggerArgs }) => {
    const tool = content.slice(TRIGGER_PREFIX.length);
    onEvent({ type: "tool_call", tool, args: cardTriggerArgs });
    onEvent({
      type: "tool_result", tool,
      result: tool === "resolve_service_link_contact"
        ? { success: true, status: "created", contact_id: "9", name: "Dana", email: "dana@x.test", link_sent: false }
        : { success: true, url: "https://x", job_name: "J" },
    });
    return { ok: true, appointments: [], remaining_unconfirmed: 0, all_confirmed: true };
  };
  await trigger("valid-token", "send_service_link", { email: "dana@x.test", first_name: "Dana", last_name: "Acme", role: "management" });
  assert.deepEqual(sendChatMessageCalls[0].cardTriggerArgs, {
    email: "dana@x.test", email_confirmed: true, first_name: "Dana", last_name: "Acme", role: "management", phone: undefined,
  });
});

test("send_service_link: email is required — 400 before any SSE stream opens", async () => {
  reset();
  const { status, json } = await trigger("valid-token", "send_service_link", {});
  assert.equal(status, 400);
  assert.match(json.error, /email/i);
  assert.equal(sendChatMessageCalls.length, 0);
});

// ── Retired routes — the six old per-action URLs are gone ──────────────────

test("the six retired per-action routes no longer exist", async () => {
  reset();
  for (const [path, body] of [
    ["/valid-token/appointments/501/confirm"],
    ["/valid-token/appointments/501/reschedule", { scheduled_start: "2026-09-01T14:00:00" }],
    ["/valid-token/appointments/501/cancel", { reason: "x" }],
    ["/valid-token/appointments/bulk-confirm", { confirm_all: true }],
    ["/valid-token/appointments/decline-remaining"],
    ["/valid-token/service-link", { email: "a@b.com" }],
  ]) {
    const { status } = await post(path, body);
    assert.equal(status, 404, `${path} must no longer be a route`);
  }
  assert.equal(sendChatMessageCalls.length, 0);
});

// ── /end (unchanged — out of scope for this migration) ──────────────────────

test("end: calls finalizeConversation with the resolved company/job", async () => {
  reset();
  const { status, json } = await post("/valid-token/end");
  assert.equal(status, 200);
  assert.equal(json.state, "chat_ended");
  assert.equal(finalizeCalls.length, 1);
  assert.equal(finalizeCalls[0].threadId, "valid-token");
  assert.equal(finalizeCalls[0].ctx.companyId, 8);
  assert.equal(finalizeCalls[0].ctx.jobId, 900);
});

test("end: 409s when other appointments are still unconfirmed and nobody's answered yet", async () => {
  reset();
  ctxResult = { ...ctxResult, counts: { unconfirmed: 2, all_confirmed: false } };
  const { status, json } = await post("/valid-token/end");
  assert.equal(status, 409);
  assert.equal(json.ok, false);
  assert.equal(json.error, "remaining_appointments_unaddressed");
  assert.equal(finalizeCalls.length, 0, "must not finalize while the gate is unsatisfied");
});

test("end: proceeds once remaining_addressed_at is set, even with others still unconfirmed", async () => {
  reset();
  ctxResult = { ...ctxResult, counts: { unconfirmed: 2, all_confirmed: false } };
  linkRow = { ...linkRow, remaining_addressed_at: new Date("2026-08-19T00:00:00Z") };
  const { status, json } = await post("/valid-token/end");
  assert.equal(status, 200);
  assert.equal(json.state, "chat_ended");
  assert.equal(finalizeCalls.length, 1);
});

test("end: proceeds with no gate at all when nothing else is unconfirmed", async () => {
  reset();
  ctxResult = { ...ctxResult, counts: { unconfirmed: 0, all_confirmed: true } };
  const { status } = await post("/valid-token/end");
  assert.equal(status, 200);
  assert.equal(finalizeCalls.length, 1);
});

test("end: passes the FULLY resolved recipient name into finalizeConversation, not just the raw snapshot", async () => {
  // Regression: resolveForAction used to hand finalizeConversation
  // link.recipient_name directly — null on most live links (no snapshot),
  // so the CRM "Who confirmed" comment fell back to "unknown" far more
  // often than it needed to. It must go through the same
  // resolveRecipient() resolution the chat agent itself uses.
  reset();
  await post("/valid-token/end");
  assert.equal(finalizeCalls[0].ctx.recipientName, "Dana", "the resolved name from resolveRecipient, sourced from the link's own snapshot here");
});
