/**
 * utils/sync-date-range.js — the ?startDate/?endDate validation shared by
 * routes/servicetrade.js and routes/inspectpoint.js's custom-range sync.
 * Extracted from routes/servicetrade.js's original private resolveSyncRange
 * (see test/servicetrade-sync-range.test.js for that route's own full
 * end-to-end coverage, unchanged by the extraction) so InspectPoint's route
 * doesn't duplicate the calendar-date/span/full-conflict rules.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { MAX_SYNC_RANGE_DAYS, isCalendarDate, validateSyncRange } = require("../src/utils/sync-date-range");

test("MAX_SYNC_RANGE_DAYS is 31 — any single calendar month is always a valid range", () => {
  assert.equal(MAX_SYNC_RANGE_DAYS, 31);
});

test("isCalendarDate accepts a real date and rejects impossible ones", () => {
  assert.equal(isCalendarDate("2026-06-01"), true);
  assert.equal(isCalendarDate("2026-02-30"), false);
  assert.equal(isCalendarDate("2026-13-01"), false);
  assert.equal(isCalendarDate("not-a-date"), false);
});

test("neither param given returns {} — the caller's default window stays in effect", () => {
  assert.deepEqual(validateSyncRange({}), {});
});

test("one date without the other is rejected", () => {
  const result = validateSyncRange({ startDate: "2026-06-01" });
  assert.match(result.error, /must be provided together/i);
});

test("a malformed or impossible date is rejected", () => {
  const result = validateSyncRange({ startDate: "2026-02-30", endDate: "2026-03-01" });
  assert.match(result.error, /Invalid date/i);
});

test("a backwards range is rejected", () => {
  const result = validateSyncRange({ startDate: "2026-06-10", endDate: "2026-06-01" });
  assert.match(result.error, /on or after/i);
});

test("exactly 31 days is allowed", () => {
  const result = validateSyncRange({ startDate: "2026-07-01", endDate: "2026-07-31" });
  assert.deepEqual(result, { startDate: "2026-07-01", endDate: "2026-07-31" });
});

test("32 days is rejected rather than quietly truncated", () => {
  const result = validateSyncRange({ startDate: "2026-07-01", endDate: "2026-08-01" });
  assert.match(result.error, /cannot exceed 31 days/);
});

test("full=true combined with a range is rejected", () => {
  const result = validateSyncRange({ startDate: "2026-06-01", endDate: "2026-06-30", full: true });
  assert.match(result.error, /cannot be combined/i);
});

test("a valid range with full omitted/false returns the validated dates verbatim", () => {
  assert.deepEqual(validateSyncRange({ startDate: "2026-06-01", endDate: "2026-06-30", full: false }), { startDate: "2026-06-01", endDate: "2026-06-30" });
});
