/**
 * How Clara tells the customer when the technician arrives — a per-company
 * setting (call_settings.arrival_time_style / arrival_minutes_before /
 * arrival_minutes_after, migration 116). Requested by a customer: "Your
 * appointment is scheduled for 11:00 AM. Please note that our technicians may
 * arrive up to 30 minutes before or after your scheduled appointment time."
 * instead of an arrival window.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const { stub, silentLogger } = require("./helpers/stub-modules");
stub("utils/logger", silentLogger());
stub("db", { query: async () => ({ rows: [], rowCount: 0 }) });
stub("services/retell", {});

const { formatArrivalStatement } = require("../src/utils/timezone");

const TZ = "America/New_York";
const ELEVEN = "2026-10-21T15:00:00Z";   // 11:00 AM EDT
const ELEVEN_THIRTY = "2026-10-21T15:30:00Z";

// ── the sentence ────────────────────────────────────────────────────────────

test("default (window, 0 before / 60 after) is today's forward-looking window", () => {
  const a = formatArrivalStatement(ELEVEN, TZ);
  assert.equal(a.style, "window");
  assert.equal(a.window, "between 11 AM and 12 PM");
  assert.equal(a.statement, "The technician is expected to arrive between 11 AM and 12 PM.");
  assert.equal(a.label, "between 11 AM and 12 PM");
});

test("the customer's request: scheduled time, technicians may arrive 30 minutes before or after", () => {
  const a = formatArrivalStatement(ELEVEN, TZ, { style: "scheduled_with_tolerance", minutesBefore: 30, minutesAfter: 30 });
  assert.equal(a.statement,
    "Your appointment is scheduled for 11 AM. Please note that our technicians may arrive up to 30 minutes before or after your scheduled appointment time.");
  assert.equal(a.window, null, "never a range — the customer asked for the scheduled time, not a window");
  assert.equal(a.label, "11 AM (±30 min)");
});

test("asymmetric and one-sided tolerances are said as such, with spoken durations", () => {
  assert.match(formatArrivalStatement(ELEVEN, TZ, { style: "scheduled_with_tolerance", minutesBefore: 15, minutesAfter: 90 }).statement,
    /may arrive up to 15 minutes before or up to 1 hour 30 minutes after your scheduled appointment time\.$/);
  assert.match(formatArrivalStatement(ELEVEN, TZ, { style: "scheduled_with_tolerance", minutesBefore: 0, minutesAfter: 60 }).statement,
    /may arrive up to 1 hour after your scheduled appointment time\.$/);
  assert.equal(formatArrivalStatement(ELEVEN, TZ, { style: "scheduled_with_tolerance", minutesBefore: 0, minutesAfter: 0 }).statement,
    "Your appointment is scheduled for 11 AM.", "0/0 tolerance is just the scheduled time");
});

test("scheduled time only, and a window centred on the time when 'before' is set", () => {
  assert.equal(formatArrivalStatement(ELEVEN_THIRTY, TZ, { style: "scheduled_only" }).statement, "Your appointment is scheduled for 11:30 AM.");
  assert.equal(formatArrivalStatement(ELEVEN, TZ, { style: "window", minutesBefore: 30, minutesAfter: 30 }).window, "between 10:30 AM and 11:30 AM");
});

test("no time → nothing to say; an unknown style falls back to the scheduled time", () => {
  assert.deepEqual(formatArrivalStatement(null, TZ, { style: "window" }), { style: "window", window: null, statement: null, label: null });
  assert.equal(formatArrivalStatement(ELEVEN, TZ, { style: "nonsense" }).statement, "Your appointment is scheduled for 11 AM.");
});

// ── the setting (PATCH /call-settings) ─────────────────────────────────────

const upserts = [];
stub("db/call-settings", {
  ARRIVAL_TIME_STYLES: ["window", "scheduled_with_tolerance", "scheduled_only"],
  getByCompanyId: async () => ({}),
  upsert: async (_c, fields) => { upserts.push(fields); return fields; },
});
stub("auth", {
  authenticate: (req, _res, next) => { req.user = { userId: 1, companyId: 16, role: "admin" }; next(); },
  getCompanyId: (req) => req.user.companyId,
});
stub("services/retell-tools", { maybeResyncToolsAfterSettingsChange: async () => ({ status: "skipped" }) });
stub("services/prompt-sync", { ensureServiceLinkPromptCurrent: async () => ({}) });

async function patch(body) {
  delete require.cache[require.resolve("../src/routes/call-settings")];
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { userId: 1, companyId: 16, role: "admin" }; next(); });
  app.use("/call-settings", require("../src/routes/call-settings"));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/call-settings`, {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return [res.status, await res.json()];
  } finally {
    server.close();
  }
}

test("PATCH /call-settings stores the arrival style and minutes", async () => {
  upserts.length = 0;
  const [status] = await patch({ arrival_time_style: "scheduled_with_tolerance", arrival_minutes_before: 30, arrival_minutes_after: 30 });
  assert.equal(status, 200);
  assert.deepEqual(upserts[0], { arrival_time_style: "scheduled_with_tolerance", arrival_minutes_before: 30, arrival_minutes_after: 30 });
});

test("an unknown style or out-of-range minutes are rejected, nothing stored", async () => {
  upserts.length = 0;
  for (const body of [
    { arrival_time_style: "exactly" },
    { arrival_minutes_before: -5 },
    { arrival_minutes_after: 241 },
    { arrival_minutes_after: 12.5 },
    { arrival_minutes_before: "30" },
  ]) {
    const [status] = await patch(body);
    assert.equal(status, 400, JSON.stringify(body));
  }
  assert.equal(upserts.length, 0);
});

test("GET /call-settings/arrival-preview returns the exact sentence for a sample 11:00 AM visit", async () => {
  delete require.cache[require.resolve("../src/routes/call-settings")];
  const app = express();
  app.use((req, _res, next) => { req.user = { userId: 1, companyId: 16, role: "admin" }; next(); });
  app.use("/call-settings", require("../src/routes/call-settings"));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/call-settings/arrival-preview`;
  try {
    let r = await (await fetch(`${base}?style=scheduled_with_tolerance&minutes_before=30&minutes_after=30`)).json();
    assert.equal(r.statement,
      "Your appointment is scheduled for 11 AM. Please note that our technicians may arrive up to 30 minutes before or after your scheduled appointment time.");
    r = await (await fetch(base)).json();
    assert.equal(r.style, "window", "omitted params use the saved (here: default) values");
    assert.equal(r.statement, "The technician is expected to arrive between 11 AM and 12 PM.");
    assert.equal((await fetch(`${base}?style=bogus`)).status, 400);
    assert.equal((await fetch(`${base}?minutes_after=999`)).status, 400);
  } finally {
    server.close();
  }
});
