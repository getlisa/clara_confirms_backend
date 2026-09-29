/**
 * Stage 1: who gets queued, and who deliberately does not.
 *
 * The properties that matter here are all about NOT sending: a company with the
 * switch off must cost nothing, a recipient must never receive an outcome they
 * did not subscribe to, and a replayed Retell webhook must not queue a second
 * email. Those are the failure modes a recipient actually notices.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);

let settings = { call_notification_enabled: true };
const settingsCalls = [];
stub("db/call-settings", {
  getByCompanyId: async (companyId) => { settingsCalls.push(companyId); return settings; },
});

let recipients = [];
const recipientQueries = [];
stub("db/call-notification-recipients", {
  // The real module's vocabulary — the resolver imports EVENT_KEYS from here.
  EVENT_KEYS: [
    "confirmed", "reschedule_requested", "cancellation_requested",
    "appointment_needed", "unconfirmed", "voicemail", "not_picked",
  ],
  listEnabledForEvent: async (companyId, event) => {
    recipientQueries.push({ companyId, event });
    return recipients.filter((r) => r.events.includes(event));
  },
});

let enqueued = [];
// Mimics the real ON CONFLICT DO NOTHING: a repeat (call, email) returns null.
let enqueueImpl = async (args) => {
  const seen = enqueued.some(
    (e) => e.retellCallId === args.retellCallId && e.email === args.email
  );
  enqueued.push(args);
  return seen ? null : { id: enqueued.length, ...args };
};
stub("db/call-notification-sends", { enqueue: async (args) => enqueueImpl(args) });

function reset() {
  settings = { call_notification_enabled: true };
  settingsCalls.length = 0;
  recipientQueries.length = 0;
  enqueued = [];
  enqueueImpl = async (args) => {
    const seen = enqueued.some(
      (e) => e.retellCallId === args.retellCallId && e.email === args.email
    );
    enqueued.push(args);
    return seen ? null : { id: enqueued.length, ...args };
  };
  recipients = [];
  logger.reset();
}

const { enqueueForConversation } = require("../src/services/call-notification");
const { resolveNotificationEvent } = require("../src/services/call-notification/event");

const CONFIRMED = {
  companyId: 8, retellCallId: "call_abc", callId: 42, channel: "voice",
  appointmentConfirmed: "yes",
};

// ── the master switch ────────────────────────────────────────────────────────

test("master switch off: nothing is queried for recipients and nothing is queued", async () => {
  reset();
  settings = { call_notification_enabled: false };

  const result = await enqueueForConversation(CONFIRMED);

  assert.equal(result.queued, 0);
  assert.equal(result.reason, "disabled");
  // The point: the settings read is the ONLY cost for a company that is off.
  assert.equal(recipientQueries.length, 0, "must not look up recipients");
  assert.equal(enqueued.length, 0);
});

test("a company with no call_settings row at all is treated as off", async () => {
  reset();
  settings = {}; // DEFAULTS shape, call_notification_enabled absent

  const result = await enqueueForConversation(CONFIRMED);
  assert.equal(result.reason, "disabled");
  assert.equal(enqueued.length, 0);
});

// ── the per-recipient event filter ───────────────────────────────────────────

test("a recipient subscribed only to cancellations gets nothing from a confirmed call", async () => {
  reset();
  recipients = [{ id: 1, email: "maxwell@ufp.test", events: ["cancellation_requested", "not_picked"] }];

  const result = await enqueueForConversation(CONFIRMED);

  assert.equal(result.event, "confirmed");
  assert.equal(result.queued, 0);
  assert.equal(result.reason, "no_recipients_for_event");
  assert.equal(enqueued.length, 0);
});

test("the same recipient DOES get the cancellation", async () => {
  reset();
  recipients = [{ id: 1, email: "maxwell@ufp.test", events: ["cancellation_requested", "not_picked"] }];

  const result = await enqueueForConversation({
    ...CONFIRMED, appointmentConfirmed: null, cancellationRequested: true,
  });

  assert.equal(result.event, "cancellation_requested");
  assert.equal(result.queued, 1);
  assert.equal(enqueued[0].email, "maxwell@ufp.test");
  assert.equal(enqueued[0].event, "cancellation_requested");
});

test("two recipients with different subscriptions are filtered independently", async () => {
  reset();
  recipients = [
    { id: 1, email: "erica@ufp.test",   events: ["confirmed", "cancellation_requested", "not_picked"] },
    { id: 2, email: "maxwell@ufp.test", events: ["cancellation_requested"] },
  ];

  await enqueueForConversation(CONFIRMED);

  assert.equal(enqueued.length, 1, "only Erica subscribes to 'confirmed'");
  assert.equal(enqueued[0].email, "erica@ufp.test");
});

// ── the sms_no_reply divergence ──────────────────────────────────────────────

test("an unanswered CHAT resolves to not_picked, not unconfirmed", async () => {
  reset();
  recipients = [{ id: 1, email: "ops@ufp.test", events: ["not_picked"] }];

  // What handleChatAnalyzed actually passes: its own synthetic reason, plus the
  // isNoAnswer it derived from routes/retell.js's NO_ANSWER_REASONS.
  const result = await enqueueForConversation({
    companyId: 8, retellCallId: "chat_xyz", callId: 43, channel: "sms",
    isNoAnswer: true, disconnectionReason: "sms_no_reply",
    appointmentConfirmed: "unclear",
  });

  assert.equal(result.event, "not_picked");
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].channel, "sms");
});

test("deriveTodoType alone would NOT reach not_picked for sms_no_reply — hence isNoAnswer is passed in", () => {
  const todosDb = require("../src/db/todos");

  // Documents the upstream quirk this resolver works around: todos.js carries
  // its own NO_ANSWER set which omits the synthetic chat reason.
  const todoType = todosDb.deriveTodoType({
    inVoicemail: false, disconnectionReason: "sms_no_reply",
    appointmentConfirmed: "unclear", rescheduleRequested: false, cancellationRequested: false,
  });
  assert.equal(todoType, todosDb.TODO_TYPES.UNCONFIRMED, "the todo path still says UNCONFIRMED");

  // Without the caller's flag the resolver would inherit that answer...
  assert.equal(
    resolveNotificationEvent({ disconnectionReason: "sms_no_reply", appointmentConfirmed: "unclear" }),
    "unconfirmed"
  );
  // ...and with it, the notification is correct.
  assert.equal(
    resolveNotificationEvent({ isNoAnswer: true, disconnectionReason: "sms_no_reply", appointmentConfirmed: "unclear" }),
    "not_picked"
  );
});

// ── duplicate protection ─────────────────────────────────────────────────────

test("a replayed call_analyzed queues nothing the second time", async () => {
  reset();
  recipients = [{ id: 1, email: "ops@ufp.test", events: ["confirmed"] }];

  const first = await enqueueForConversation(CONFIRMED);
  assert.equal(first.queued, 1);

  // Retell retries the webhook on any non-2xx; the handler is re-entrant.
  const second = await enqueueForConversation(CONFIRMED);
  assert.equal(second.queued, 0, "the unique index absorbed it");
  assert.equal(second.event, "confirmed", "still classified, just not re-queued");
});

// ── isolation ────────────────────────────────────────────────────────────────

test("one recipient's enqueue failure does not cost the others theirs", async () => {
  reset();
  recipients = [
    { id: 1, email: "broken@ufp.test", events: ["confirmed"] },
    { id: 2, email: "fine@ufp.test",   events: ["confirmed"] },
  ];
  enqueueImpl = async (args) => {
    if (args.email === "broken@ufp.test") throw new Error("deadlock detected");
    return { id: 99, ...args };
  };

  const result = await enqueueForConversation(CONFIRMED);

  assert.equal(result.queued, 1, "the healthy recipient still got queued");
  assert.ok(logger.records.error.some(([msg]) => /enqueue failed/i.test(String(msg))),
    "the failure was logged, not swallowed silently");
});

test("a missing companyId or retellCallId is refused before any query", async () => {
  reset();
  const noCompany = await enqueueForConversation({ retellCallId: "call_x" });
  assert.equal(noCompany.reason, "missing_identifiers");
  const noCall = await enqueueForConversation({ companyId: 8 });
  assert.equal(noCall.reason, "missing_identifiers");
  assert.equal(settingsCalls.length, 0);
});

// ── the full taxonomy, end to end ────────────────────────────────────────────

test("every event key can be reached, and each conversation produces exactly one", async () => {
  const cases = [
    ["confirmed",              { appointmentConfirmed: "yes" }],
    ["reschedule_requested",   { rescheduleRequested: true }],
    ["cancellation_requested", { cancellationRequested: true }],
    ["appointment_needed",     { customerOutcome: "appointment_needed" }],
    ["unconfirmed",            { appointmentConfirmed: "unclear" }],
    ["voicemail",              { inVoicemail: true }],
    ["not_picked",             { isNoAnswer: true, disconnectionReason: "dial_no_answer" }],
  ];

  for (const [expected, outcome] of cases) {
    reset();
    // Subscribed to EVERYTHING — so if a conversation could match two events,
    // this would queue twice and the assertion below would catch it.
    recipients = [{
      id: 1, email: "ops@ufp.test",
      events: ["confirmed", "reschedule_requested", "cancellation_requested",
               "appointment_needed", "unconfirmed", "voicemail", "not_picked"],
    }];

    const result = await enqueueForConversation({ companyId: 8, retellCallId: `call_${expected}`, ...outcome });
    assert.equal(result.event, expected, `${expected} should resolve to itself`);
    assert.equal(enqueued.length, 1, `${expected} must queue exactly one email`);
  }
});

// ── logging ──────────────────────────────────────────────────────────────────

test("the two silent outcomes are logged, since they are what 'no email arrived' means", async () => {
  // Switch off.
  reset();
  settings = { call_notification_enabled: false };
  await enqueueForConversation(CONFIRMED);
  assert.ok(logger.records.info.some(([msg]) => /notifications are off/.test(String(msg))),
    "a company with the switch off says so");

  // Nobody subscribed to this outcome.
  reset();
  recipients = [{ id: 1, email: "maxwell@ufp.test", events: ["cancellation_requested"] }];
  await enqueueForConversation(CONFIRMED);
  assert.ok(logger.records.info.some(([msg]) => /no enabled recipient subscribed/.test(String(msg))),
    "an unsubscribed outcome says so, and names the event");
});

test("the classification log carries the inputs that produced it", async () => {
  reset();
  recipients = [{ id: 1, email: "ops@ufp.test", events: ["not_picked"] }];
  await enqueueForConversation({
    companyId: 8, retellCallId: "chat_xyz", channel: "sms",
    isNoAnswer: true, disconnectionReason: "sms_no_reply", appointmentConfirmed: "unclear",
  });

  const line = logger.records.info.find(([msg]) => /outcome classified/.test(String(msg)));
  assert.ok(line, "the verdict is logged");
  const [, meta] = line;
  assert.equal(meta.event, "not_picked");
  // Without the inputs alongside the verdict, a misclassification can only be
  // diagnosed by replaying the webhook.
  assert.equal(meta.from.disconnectionReason, "sms_no_reply");
  assert.equal(meta.from.isNoAnswer, true);
});

test("queued and duplicate-skipped are logged distinctly, and addresses are masked", async () => {
  reset();
  recipients = [{ id: 1, email: "erica@ultimatefire.test", events: ["confirmed"] }];

  await enqueueForConversation(CONFIRMED);
  assert.ok(logger.records.info.some(([msg]) => /→ queued/.test(String(msg))));

  await enqueueForConversation(CONFIRMED); // webhook replay
  assert.ok(logger.records.info.some(([msg]) => /already queued/.test(String(msg))),
    "a replay is visibly a replay, not a silent no-op");

  const allLogs = JSON.stringify(logger.records);
  assert.ok(!allLogs.includes("erica@ultimatefire.test"), "full address never logged");
  assert.ok(allLogs.includes("erica@***"));
});
