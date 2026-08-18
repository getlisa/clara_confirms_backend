/**
 * The date/time logic behind the daily report — pure, no DB, "now" always
 * passed in explicitly so every case below is exact and repeatable.
 *
 * The core rule: a recipient's report covers the last BUSINESS DAY that had
 * already finished at their chosen send time. Whether that's today or
 * yesterday depends only on send_at_local vs business_hours_end — never on
 * what day "now" happens to be.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { localParts, addDays, isWeekend, computeTargetDate, resolveDue } = require("../src/services/daily-report/schedule");

// ── computeTargetDate — the table from the plan, worked exactly ────────────

test("worked examples: business_hours_end = 17:00", () => {
  const cases = [
    ["21:00", "today"],
    ["23:59", "today"],
    ["01:00", "yesterday"],
    ["10:00", "yesterday"], // mid-day — today isn't finished yet
    ["17:00", "today"],     // exactly business close counts as finished
    ["16:59", "yesterday"], // one minute before close
  ];
  for (const [sendAtLocal, expected] of cases) {
    const got = computeTargetDate({ sendAtLocal, businessHoursEnd: "17:00", todayLocal: "2026-08-18" });
    const want = expected === "today" ? "2026-08-18" : "2026-08-17";
    assert.equal(got, want, `${sendAtLocal} should report ${expected}`);
  }
});

test("accepts pg TIME's 'HH:MM:SS' form directly", () => {
  assert.equal(computeTargetDate({ sendAtLocal: "21:00:00", businessHoursEnd: "17:00:00", todayLocal: "2026-08-18" }), "2026-08-18");
  assert.equal(computeTargetDate({ sendAtLocal: "09:00:00", businessHoursEnd: "17:00:00", todayLocal: "2026-08-18" }), "2026-08-17");
});

// ── addDays / weekday — calendar arithmetic, immune to host tz ──────────────

test("addDays crosses a month and year boundary correctly", () => {
  assert.equal(addDays("2026-08-31", 1), "2026-09-01");
  assert.equal(addDays("2027-01-01", -1), "2026-12-31");
});

test("isWeekend matches the actual calendar", () => {
  // 2026-08-15 is a Saturday, 2026-08-17 a Monday.
  assert.equal(isWeekend("2026-08-15"), true);
  assert.equal(isWeekend("2026-08-16"), true);
  assert.equal(isWeekend("2026-08-17"), false);
});

// ── localParts — DST boundaries ─────────────────────────────────────────────

test("localParts crosses the US spring-forward boundary correctly", () => {
  // 2026-03-08 07:30 UTC is 01:30 CST (still -06:00, before the 2am jump).
  const before = localParts(new Date("2026-03-08T07:30:00Z"), "America/Chicago");
  assert.equal(before.date, "2026-03-08");
  assert.equal(before.time, "01:30");

  // 2026-03-08 08:30 UTC is 03:30 CDT (-05:00, after the jump) — same UTC day,
  // one hour later UTC produced two hours later local across the gap.
  const after = localParts(new Date("2026-03-08T08:30:00Z"), "America/Chicago");
  assert.equal(after.time, "03:30");
});

test("localParts crosses the US fall-back boundary correctly", () => {
  // 2026-11-01 06:30 UTC → 01:30 CDT (still -05:00, before the repeat hour).
  const first = localParts(new Date("2026-11-01T06:30:00Z"), "America/Chicago");
  assert.equal(first.time, "01:30");
  // One hour later UTC is 01:30 CST again (-06:00) — the repeated wall-clock
  // hour. Both must resolve without throwing; the sweep's 15-min cadence and
  // idempotency guard (see resolveDue tests) are what keep this from double-firing.
  const second = localParts(new Date("2026-11-01T07:30:00Z"), "America/Chicago");
  assert.equal(second.time, "01:30");
  assert.equal(first.date, second.date);
});

test("weekday is the LOCAL calendar day, not the UTC one", () => {
  // 2026-08-16 23:30 US/Pacific (a Sunday night) is already 2026-08-17 06:30
  // UTC (a Monday) — a report resolver keyed off UTC would misfire the
  // weekend skip a day early for west-coast companies.
  const p = localParts(new Date("2026-08-17T06:30:00Z"), "America/Los_Angeles");
  assert.equal(p.date, "2026-08-16");
  assert.equal(p.weekday, 0, "Sunday");
});

// ── resolveDue — the sweep's actual decision ────────────────────────────────

function due(overrides = {}) {
  return resolveDue({
    nowUtc: new Date("2026-08-18T21:00:00Z"), // 21:00 UTC — a plain UTC company, Tuesday
    tz: "UTC",
    sendAtLocal: "21:00",
    businessHoursEnd: "17:00",
    includeWeekends: false,
    lastSentForDate: null,
    ...overrides,
  });
}

test("fires exactly at the chosen local time, for the correct target date", () => {
  const r = due();
  assert.equal(r.due, true);
  assert.equal(r.targetDate, "2026-08-18");
});

test("does not fire before the chosen local time", () => {
  const r = due({ nowUtc: new Date("2026-08-18T20:00:00Z") }); // 20:00 UTC, before 21:00
  assert.equal(r.due, false);
  assert.equal(r.reason, "not_yet_time");
});

test("a second sweep run within the same day is a no-op", () => {
  // The idempotency guard: same target date already stamped as sent.
  const r = due({ nowUtc: new Date("2026-08-18T21:15:00Z"), lastSentForDate: "2026-08-18" });
  assert.equal(r.due, false);
  assert.equal(r.reason, "already_sent");
});

test("a catch-up run after an outage still fires once the moment has passed", () => {
  // The cron was down at 21:00 and recovers at 23:40 — the condition must
  // still hold so the report goes out late rather than silently never.
  const r = due({ nowUtc: new Date("2026-08-18T23:40:00Z") });
  assert.equal(r.due, true);
  assert.equal(r.targetDate, "2026-08-18");
});

test("a weekend target date is skipped entirely — no send, nothing stamped", () => {
  // 2026-08-15 is a Saturday. Sending at 21:00 that day would target 08-15.
  const r = due({ nowUtc: new Date("2026-08-15T21:00:00Z"), includeWeekends: false });
  assert.equal(r.due, false);
  assert.equal(r.reason, "weekend");
  assert.equal(r.targetDate, "2026-08-15", "the target date is still reported, for the caller's logging");
});

test("include_weekends=true sends on a weekend target date", () => {
  const r = due({ nowUtc: new Date("2026-08-15T21:00:00Z"), includeWeekends: true });
  assert.equal(r.due, true);
});

test("a 1 AM recipient targets yesterday and fires only after 1 AM local", () => {
  const r1 = resolveDue({
    nowUtc: new Date("2026-08-18T00:30:00Z"), tz: "UTC",
    sendAtLocal: "01:00", businessHoursEnd: "17:00",
    includeWeekends: true, lastSentForDate: null,
  });
  assert.equal(r1.due, false, "00:30 is before 01:00");

  const r2 = resolveDue({
    nowUtc: new Date("2026-08-18T01:00:00Z"), tz: "UTC",
    sendAtLocal: "01:00", businessHoursEnd: "17:00",
    includeWeekends: true, lastSentForDate: null,
  });
  assert.equal(r2.due, true);
  assert.equal(r2.targetDate, "2026-08-17", "at 1am on the 18th, yesterday (the 17th) is the last finished day");
});

test("resolveDue uses the RECIPIENT's own timezone, not the server's", () => {
  // 04:00 UTC is 23:00 in Chicago the PREVIOUS calendar day (CDT, -05:00) —
  // a resolver that used server/UTC local time would compute the wrong
  // target date entirely.
  const r = resolveDue({
    nowUtc: new Date("2026-08-18T04:00:00Z"), tz: "America/Chicago",
    sendAtLocal: "23:00", businessHoursEnd: "17:00",
    includeWeekends: true, lastSentForDate: null,
  });
  assert.equal(r.due, true);
  assert.equal(r.targetDate, "2026-08-17");
});
