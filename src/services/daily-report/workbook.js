/**
 * Rows (from collect.js) → an .xlsx Buffer, one sheet per section. Every
 * sheet gets a frozen header row and a real autofilter, so a recipient can
 * filter the workbook itself rather than asking someone to re-run a query.
 */

const ExcelJS = require("exceljs");

/** null/undefined never render as the literal string "null"/"undefined". */
function cell(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v;
  return v;
}

function addSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));
  for (const row of rows) {
    sheet.addRow(Object.fromEntries(columns.map((c) => [c.key, cell(row[c.key])])));
  }
  sheet.getRow(1).font = { bold: true };
  // Always on, even with zero data rows — a recipient opening an empty sheet
  // should still see the same filter UI every other sheet has, not a subtly
  // different one depending on whether anything happened that day.
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(rows.length, 1) + 1, column: columns.length } };
  return sheet;
}

function buildSummarySheet(workbook, summary, meta) {
  const sheet = workbook.addWorksheet("Summary");
  sheet.columns = [{ key: "label", width: 42 }, { key: "value", width: 40 }];
  const rows = [
    ["Company", meta.companyName],
    ["Report covers", summary.business_date],
    ["Generated", meta.generatedAtLabel],
    ["", ""],
    ["Customers reached out to", summary.outreach_count],
    ["Confirmed", summary.confirmed_count],
    ["Asked to reschedule (completed)", summary.rescheduled_count],
    ["Cancelled", summary.cancelled_count],
    ["Awaiting response (from earlier days)", summary.awaiting_response_count],
    ["Open action items & escalations", summary.action_items_count],
  ];
  for (const [label, value] of rows) sheet.addRow({ label, value });
  sheet.getColumn(1).font = { bold: true };
  if (meta.ledgerCoverageNote) {
    sheet.addRow({});
    const note = sheet.addRow({ label: "Note", value: meta.ledgerCoverageNote });
    note.getCell(2).alignment = { wrapText: true };
  }
  if (summary.confirmed_count !== summary.confirmed_count_appointments_crosscheck) {
    sheet.addRow({});
    sheet.addRow({
      label: "Data check",
      value: `${summary.confirmed_count_appointments_crosscheck} appointments show as confirmed today by their own timestamp, vs ${summary.confirmed_count} in this report's detail — see the note above.`,
    });
  }
  return sheet;
}

/**
 * @param {object} data  the six collect.js results, plus `summary`.
 * @param {object} meta  { companyName, generatedAtLabel, ledgerCoverageNote }
 * @returns {Promise<Buffer>}
 */
async function buildWorkbook(data, meta) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Clara Confirms";
  workbook.created = meta.generatedAt || new Date();

  buildSummarySheet(workbook, data.summary, meta);

  addSheet(workbook, "Outreach", [
    { key: "channel", header: "Channel", width: 12 },
    { key: "job_number", header: "Job #", width: 14 },
    { key: "job_name", header: "Job", width: 28 },
    { key: "recipient_name", header: "Sent To", width: 22 },
    { key: "destination", header: "Destination", width: 24 },
    { key: "sent_at", header: "Sent At", width: 20 },
    { key: "opened", header: "Opened?", width: 10 },
    { key: "responded", header: "Responded?", width: 12 },
  ], data.outreach);

  addSheet(workbook, "Confirmed", [
    { key: "occurred_at", header: "When", width: 20 },
    { key: "actor_name", header: "Who Confirmed", width: 22 },
    { key: "channel", header: "Channel", width: 12 },
    { key: "job_number", header: "Job #", width: 14 },
    { key: "job_name", header: "Job", width: 28 },
    { key: "location_name", header: "Site", width: 24 },
    { key: "scheduled_start", header: "Visit Date/Time", width: 20 },
  ], data.confirmed);

  addSheet(workbook, "Reschedules", [
    { key: "occurred_at", header: "When", width: 20 },
    { key: "actor_name", header: "Who", width: 22 },
    { key: "channel", header: "Channel", width: 12 },
    { key: "job_number", header: "Job #", width: 14 },
    { key: "job_name", header: "Job", width: 28 },
    { key: "location_name", header: "Site", width: 24 },
    { key: "from", header: "Original Time", width: 20 },
    { key: "to", header: "New Time", width: 20 },
  ], data.reschedules.map((r) => ({ ...r, from: r.details?.from, to: r.details?.to })));

  addSheet(workbook, "Cancellations", [
    { key: "occurred_at", header: "When", width: 20 },
    { key: "actor_name", header: "Who", width: 22 },
    { key: "channel", header: "Channel", width: 12 },
    { key: "job_number", header: "Job #", width: 14 },
    { key: "job_name", header: "Job", width: 28 },
    { key: "location_name", header: "Site", width: 24 },
    { key: "reason", header: "Reason", width: 30 },
    { key: "scope", header: "Scope", width: 16 },
  ], data.cancellations.map((r) => ({ ...r, reason: r.details?.reason, scope: r.details?.scope })));

  addSheet(workbook, "Awaiting Response", [
    { key: "sent_date_local", header: "Originally Sent", width: 16 },
    { key: "age_days", header: "Days Ago", width: 10 },
    { key: "job_number", header: "Job #", width: 14 },
    { key: "job_name", header: "Job", width: 28 },
    { key: "location_name", header: "Site", width: 24 },
    { key: "recipient_name", header: "Sent To", width: 22 },
    { key: "recipient_email", header: "Email", width: 24 },
    { key: "recipient_phone", header: "Phone", width: 18 },
    { key: "opened", header: "Opened?", width: 10 },
    { key: "status", header: "Link Status", width: 14 },
  ], data.awaitingResponse);

  addSheet(workbook, "Action Items", [
    { key: "type", header: "Type", width: 22 },
    { key: "priority", header: "Priority", width: 10 },
    { key: "job_number", header: "Job #", width: 14 },
    { key: "job_name", header: "Job", width: 28 },
    { key: "location_name", header: "Site", width: 24 },
    { key: "subject_name", header: "Subject", width: 22 },
    { key: "created_at", header: "Raised", width: 20 },
  ], data.actionItems.map((r) => ({ ...r, subject_name: r.metadata?.subject_name ?? null })));

  return workbook.xlsx.writeBuffer();
}

module.exports = { buildWorkbook };
