/**
 * The delivery pipeline: collect → build → email → stamp sent.
 *
 * The sweep's most important property is ISOLATION: one recipient's bad data
 * (a broken company, a DB error) must never silence every other company's
 * report, and a recipient who is not due right now must not be touched at all
 * — not queried for a workbook, not emailed, not stamped.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { stub, silentLogger } = require("./helpers/stub-modules");

const logger = silentLogger();
stub("utils/logger", logger);

const collectCalls = [];
stub("services/daily-report/collect", {
  collectOutreach: async (co, d) => { collectCalls.push(["outreach", co, d]); return []; },
  collectConfirmed: async (co, d) => { collectCalls.push(["confirmed", co, d]); return []; },
  collectReschedules: async (co, d) => { collectCalls.push(["reschedules", co, d]); return []; },
  collectCancellations: async (co, d) => { collectCalls.push(["cancellations", co, d]); return []; },
  collectAwaitingResponse: async (co, d) => { collectCalls.push(["awaiting", co, d]); return []; },
  collectActionItems: async (co) => { collectCalls.push(["action_items", co]); return []; },
  collectSummary: async (co, d) => { collectCalls.push(["summary", co, d]); return {
    business_date: d, outreach_count: 0, confirmed_count: 0, rescheduled_count: 0,
    cancelled_count: 0, awaiting_response_count: 0, action_items_count: 0, confirmed_count_appointments_crosscheck: 0,
  }; },
});

let workbookCalls = [];
stub("services/daily-report/workbook", { buildWorkbook: async (data, meta) => { workbookCalls.push({ data, meta }); return Buffer.from("xlsx-bytes"); } });

const sendMailCalls = [];
let sendMailImpl = async () => true;
stub("utils/email", {
  sendMail: async (args) => { sendMailCalls.push(args); return sendMailImpl(args); },
  buildEmailTemplate: (args) => `<html>${args.title}</html>`,
});

const markSentCalls = [];
let recipientsRows = [];
stub("db/report-recipients", {
  listAllEnabledForSweep: async () => recipientsRows,
  markSent: async (id, date) => { markSentCalls.push({ id, date }); },
});

const dbQueries = [];
stub("db", { query: async (sql, params) => { dbQueries.push({ sql, params }); return { rows: [{ name: "Acme HVAC" }] }; } });

function reset() {
  collectCalls.length = 0; workbookCalls = []; sendMailCalls.length = 0; markSentCalls.length = 0;
  dbQueries.length = 0; recipientsRows = []; sendMailImpl = async () => true;
  logger.reset();
}

const { sendForRecipient, runSweep } = require("../src/services/daily-report/send");

// ── sendForRecipient ─────────────────────────────────────────────────────────

test("sendForRecipient collects every sheet for the given company and date, emails the workbook, and stamps sent", async () => {
  reset();
  const recipient = { id: 5, company_id: 8, email: "ops@acme.test", name: "Ops" };
  const result = await sendForRecipient(recipient, { businessDate: "2026-08-13", companyName: "Acme HVAC", tz: "America/Chicago" });

  assert.equal(result.sent, true);
  assert.ok(collectCalls.every(([, co, d]) => co === 8 && (d === undefined || d === "2026-08-13")));
  assert.equal(sendMailCalls.length, 1);
  assert.equal(sendMailCalls[0].to, "ops@acme.test");
  assert.equal(sendMailCalls[0].attachments.length, 1);
  assert.match(sendMailCalls[0].attachments[0].filename, /2026-08-13\.xlsx$/);
  assert.equal(sendMailCalls[0].attachments[0].contentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.deepEqual(markSentCalls, [{ id: 5, date: "2026-08-13" }]);
});

test("send-now (stampSent: false) emails but does NOT stamp last_sent_for_date", async () => {
  reset();
  const recipient = { id: 5, company_id: 8, email: "ops@acme.test" };
  await sendForRecipient(recipient, { businessDate: "2026-08-13", companyName: "Acme HVAC", tz: "America/Chicago", stampSent: false });
  assert.equal(sendMailCalls.length, 1, "it still actually sends — this is a real test send");
  assert.deepEqual(markSentCalls, [], "so a manual test send can be repeated without faking the schedule");
});

test("a date before the ledger start attaches a coverage caveat to the workbook", async () => {
  reset();
  await sendForRecipient({ id: 1, company_id: 8, email: "a@x.test" }, { businessDate: "2020-01-01", companyName: "Acme", tz: "UTC" });
  assert.match(workbookCalls[0].meta.ledgerCoverageNote, /2020-01-01/);
});

test("a date on/after the ledger start has no coverage caveat", async () => {
  reset();
  await sendForRecipient({ id: 1, company_id: 8, email: "a@x.test" }, { businessDate: "2026-08-18", companyName: "Acme", tz: "UTC" });
  assert.equal(workbookCalls[0].meta.ledgerCoverageNote, null);
});

// ── runSweep ─────────────────────────────────────────────────────────────────

function recipient(overrides = {}) {
  return {
    id: 1, company_id: 8, email: "a@x.test", send_at_local: "21:00",
    default_timezone: "UTC", business_hours_end: "17:00", include_weekends: false,
    last_sent_for_date: null,
    ...overrides,
  };
}

test("runSweep sends only the recipients who are actually due, and stamps each", async () => {
  reset();
  recipientsRows = [recipient({ id: 1 }), recipient({ id: 2, send_at_local: "23:00" })];
  // now = 21:15 UTC — recipient 1 (21:00) is due; recipient 2 (23:00) is not yet.
  const result = await runSweep(new Date("2026-08-18T21:15:00Z"));
  assert.equal(result.sent, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(markSentCalls.map((m) => m.id), [1]);
});

test("a recipient already sent for today's target date is skipped, not re-sent", async () => {
  reset();
  recipientsRows = [recipient({ id: 1, last_sent_for_date: "2026-08-18" })];
  const result = await runSweep(new Date("2026-08-18T21:15:00Z"));
  assert.equal(result.sent, 0);
  assert.equal(result.skipped, 1);
  assert.equal(result.details[0].reason, "already_sent");
});

test("one recipient's send failure does not stop the sweep for the rest", async () => {
  reset();
  recipientsRows = [recipient({ id: 1 }), recipient({ id: 2 })];
  let call = 0;
  sendMailImpl = async () => { call += 1; if (call === 1) throw new Error("SendGrid down"); return true; };
  const result = await runSweep(new Date("2026-08-18T21:15:00Z"));
  assert.equal(result.errors, 1);
  assert.equal(result.sent, 1, "the second recipient still gets their report");
  assert.deepEqual(markSentCalls.map((m) => m.id), [2], "the failed recipient must NOT be stamped, so it retries next sweep");
});

test("a company with no call_settings row defaults to 17:00 close and weekdays only", async () => {
  reset();
  // business_hours_end/include_weekends null — as a LEFT JOIN with no
  // call_settings row would produce.
  recipientsRows = [recipient({ business_hours_end: null, include_weekends: null })];
  // 2026-08-15 is a Saturday — must be skipped as a weekend under the default.
  const result = await runSweep(new Date("2026-08-15T21:15:00Z"));
  assert.equal(result.sent, 0);
  assert.equal(result.details[0].reason, "weekend");
});

test("the 17:00 default close time is the ACTUAL value used, not just any fallback", async () => {
  reset();
  // send_at_local=10:00 with a 17:00 close means "today isn't finished yet" →
  // targets YESTERDAY. If the code fell back to something earlier than 10:00
  // (e.g. 09:00), this same recipient would wrongly target TODAY instead.
  recipientsRows = [recipient({
    id: 1, send_at_local: "10:00", business_hours_end: null, include_weekends: null,
  })];
  // 2026-08-18 is a Tuesday, 10:30 local (UTC company) — past send time.
  const result = await runSweep(new Date("2026-08-18T10:30:00Z"));
  assert.equal(result.sent, 1);
  assert.equal(result.details[0].targetDate, "2026-08-17");
});

test("companyName is looked up fresh per send, not assumed", async () => {
  reset();
  recipientsRows = [recipient({ id: 1 })];
  await runSweep(new Date("2026-08-18T21:15:00Z"));
  assert.ok(dbQueries.some((q) => q.sql.includes("FROM companies") && q.params[0] === 8));
  // Not just that a lookup happened — that its RESULT is what actually reaches
  // the workbook, not a hardcoded placeholder.
  assert.equal(workbookCalls[0].meta.companyName, "Acme HVAC");
});
