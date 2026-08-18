/**
 * Rows → .xlsx. The workbook is the actual deliverable — a wrong sheet name,
 * a missing filter, or a literal "undefined" cell is what a recipient
 * actually sees, so this reads the built file back rather than trusting
 * exceljs's write call to have done the right thing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");

const { buildWorkbook } = require("../src/services/daily-report/workbook");

const EMPTY = { outreach: [], confirmed: [], reschedules: [], cancellations: [], awaitingResponse: [], actionItems: [],
  summary: { business_date: "2026-08-13", outreach_count: 0, confirmed_count: 0, rescheduled_count: 0,
    cancelled_count: 0, awaiting_response_count: 0, action_items_count: 0, confirmed_count_appointments_crosscheck: 0 } };

async function readBack(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  return wb;
}

test("every sheet exists, in order, even with zero data anywhere", async () => {
  const buf = await buildWorkbook(EMPTY, { companyName: "Acme", generatedAtLabel: "now" });
  const wb = await readBack(buf);
  assert.deepEqual(wb.worksheets.map((s) => s.name),
    ["Summary", "Outreach", "Confirmed", "Reschedules", "Cancellations", "Awaiting Response", "Action Items"]);
});

test("every detail sheet has an autofilter, even with no rows", async () => {
  const buf = await buildWorkbook(EMPTY, { companyName: "Acme", generatedAtLabel: "now" });
  const wb = await readBack(buf);
  for (const name of ["Outreach", "Confirmed", "Reschedules", "Cancellations", "Awaiting Response", "Action Items"]) {
    assert.ok(wb.getWorksheet(name).autoFilter, `${name} must have a filter — a recipient shouldn't get a different UI on a quiet day`);
  }
});

test("no cell ever renders the literal string 'null' or 'undefined'", async () => {
  const data = {
    ...EMPTY,
    outreach: [{ channel: "chat", job_id: null, job_name: null, job_number: null, recipient_name: null, destination: null, sent_at: new Date(), opened: null, responded: false }],
    confirmed: [{ occurred_at: new Date(), actor_name: null, channel: "chat", job_number: null, job_name: null, location_name: null, scheduled_start: null }],
    reschedules: [{ occurred_at: new Date(), actor_name: null, channel: "voice", job_number: null, job_name: null, location_name: null, details: {} }],
    cancellations: [{ occurred_at: new Date(), actor_name: null, channel: "voice", job_number: null, job_name: null, location_name: null, details: {} }],
    actionItems: [{ type: "UNCONFIRMED", priority: null, job_number: null, job_name: null, location_name: null, metadata: {}, created_at: new Date() }],
  };
  const buf = await buildWorkbook(data, { companyName: "Acme", generatedAtLabel: "now" });
  const wb = await readBack(buf);
  const bad = [];
  for (const sheet of wb.worksheets) {
    sheet.eachRow((row) => row.eachCell((c) => { if (c.value === "null" || c.value === "undefined") bad.push(`${sheet.name}!${c.address}`); }));
  }
  assert.deepEqual(bad, []);
});

test("a reschedule's from/to and a cancellation's reason/scope are pulled out of `details`", async () => {
  const data = {
    ...EMPTY,
    reschedules: [{ occurred_at: new Date(), actor_name: "Dana", channel: "chat", job_number: "1", job_name: "J", location_name: "Site", details: { from: "2026-08-10T14:00:00Z", to: "2026-08-20T14:00:00Z" } }],
    cancellations: [{ occurred_at: new Date(), actor_name: "Dana", channel: "chat", job_number: "1", job_name: "J", location_name: "Site", details: { reason: "no longer needed", scope: "appointment_only" } }],
  };
  const buf = await buildWorkbook(data, { companyName: "Acme", generatedAtLabel: "now" });
  const wb = await readBack(buf);
  const reschedRow = wb.getWorksheet("Reschedules").getRow(2).values;
  assert.ok(reschedRow.includes("2026-08-10T14:00:00Z") && reschedRow.includes("2026-08-20T14:00:00Z"));
  const cancelRow = wb.getWorksheet("Cancellations").getRow(2).values;
  assert.ok(cancelRow.includes("no longer needed") && cancelRow.includes("appointment_only"));
});

test("an action item's subject name is pulled out of `metadata`", async () => {
  const data = { ...EMPTY, actionItems: [
    { type: "MISSING_PHONE", priority: "high", job_number: "1", job_name: "J", location_name: "Site", metadata: { subject_name: "Dana Acme" }, created_at: new Date() },
  ] };
  const buf = await buildWorkbook(data, { companyName: "Acme", generatedAtLabel: "now" });
  const wb = await readBack(buf);
  assert.ok(wb.getWorksheet("Action Items").getRow(2).values.includes("Dana Acme"));
});

test("the Summary sheet surfaces a ledger-coverage caveat when given one", async () => {
  const buf = await buildWorkbook(EMPTY, { companyName: "Acme", generatedAtLabel: "now", ledgerCoverageNote: "outcome tracking began later" });
  const wb = await readBack(buf);
  const summaryText = [];
  wb.getWorksheet("Summary").eachRow((row) => row.eachCell((c) => summaryText.push(String(c.value))));
  assert.ok(summaryText.some((v) => v.includes("outcome tracking began later")));
});

test("a confirmed/crosscheck mismatch surfaces as a visible data-check row", async () => {
  const data = { ...EMPTY, summary: { ...EMPTY.summary, confirmed_count: 0, confirmed_count_appointments_crosscheck: 2 } };
  const buf = await buildWorkbook(data, { companyName: "Acme", generatedAtLabel: "now" });
  const wb = await readBack(buf);
  const summaryText = [];
  wb.getWorksheet("Summary").eachRow((row) => row.eachCell((c) => summaryText.push(String(c.value))));
  assert.ok(summaryText.some((v) => v.includes("Data check")));
});
