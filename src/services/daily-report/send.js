/**
 * Collect → build the workbook → email it → stamp last_sent_for_date.
 *
 * Two entry points: sendForRecipient (one recipient, used by both the sweep
 * and the manual "send now" route) and runSweep (every enabled recipient
 * across every company, due right now).
 */

const db = require("../../db");
const collect = require("./collect");
const { buildWorkbook } = require("./workbook");
const { resolveDue } = require("./schedule");
const reportRecipientsDb = require("../../db/report-recipients");
const { sendMail, buildEmailTemplate } = require("../../utils/email");
const { timezoneLabel } = require("../../utils/timezone");
const logger = require("../../utils/logger");

// The date this ledger started recording — see migrations/097. Surfaced on
// every report rather than silently under-counting a day the sweep can't
// actually know anything about.
const LEDGER_START_DATE = "2026-08-18";

function ledgerCoverageNote(businessDate) {
  if (businessDate >= LEDGER_START_DATE) return null;
  return `This report is for ${businessDate}, before outcome tracking (confirmed/rescheduled/cancelled) began on ${LEDGER_START_DATE}. Those sections may undercount for this date.`;
}

/**
 * Build and send ONE recipient's report for ONE business date — independent
 * of whether it's actually "due"; the sweep checks that separately, and
 * send-now (manual/testing) deliberately skips the check entirely.
 */
async function sendForRecipient(recipient, { businessDate, companyName, tz, stampSent = true } = {}) {
  const [outreach, confirmed, reschedules, cancellations, awaitingResponse, actionItems, summary] = await Promise.all([
    collect.collectOutreach(recipient.company_id, businessDate, tz),
    collect.collectConfirmed(recipient.company_id, businessDate, tz),
    collect.collectReschedules(recipient.company_id, businessDate, tz),
    collect.collectCancellations(recipient.company_id, businessDate, tz),
    collect.collectAwaitingResponse(recipient.company_id, businessDate, tz),
    collect.collectActionItems(recipient.company_id),
    collect.collectSummary(recipient.company_id, businessDate, tz),
  ]);

  const buffer = await buildWorkbook(
    { outreach, confirmed, reschedules, cancellations, awaitingResponse, actionItems, summary },
    {
      companyName,
      generatedAtLabel: `${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
      ledgerCoverageNote: ledgerCoverageNote(businessDate),
    }
  );

  const summaryRows = [
    ["Customers reached out to", summary.outreach_count],
    ["Confirmed", summary.confirmed_count],
    ["Asked to reschedule", summary.rescheduled_count],
    ["Cancelled", summary.cancelled_count],
    ["Awaiting response (earlier days)", summary.awaiting_response_count],
    ["Open action items", summary.action_items_count],
  ];
  const summaryTableHtml = `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-top: 8px;">
      ${summaryRows.map(([label, value]) => `
        <tr>
          <td style="padding: 6px 0; color: #334155; font-size: 14px;">${label}</td>
          <td style="padding: 6px 0; text-align: right; font-weight: 700; color: #0f172a; font-size: 14px;">${value}</td>
        </tr>`).join("")}
    </table>`;

  const html = buildEmailTemplate({
    userName: recipient.name,
    companyName,
    title: `${companyName} — ${businessDate} operations report`,
    bodyHtml: `<p style="margin: 0 0 12px 0;">Here's how ${businessDate} went. Full detail is in the attached workbook.</p>${summaryTableHtml}`,
    footerText: ledgerCoverageNote(businessDate) || "Every sheet in the attachment can be filtered — click the arrow in any column header.",
  });

  await sendMail({
    to: recipient.email,
    subject: `${companyName} daily report — ${businessDate}`,
    html,
    attachments: [{
      filename: `${companyName.replace(/[^a-z0-9]+/gi, "-")}-report-${businessDate}.xlsx`,
      content: buffer,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }],
  });

  if (stampSent) await reportRecipientsDb.markSent(recipient.id, businessDate);

  logger.info("Daily report sent", { companyId: recipient.company_id, recipientId: recipient.id, businessDate, ...summary });
  return { sent: true, businessDate, summary };
}

/**
 * Every enabled recipient across every company, evaluated against `now` —
 * called by the admin sweep route on a schedule. Failures are per-recipient
 * and never stop the sweep; one company's bad data must not silence every
 * other company's report.
 */
async function runSweep(now = new Date()) {
  const recipients = await reportRecipientsDb.listAllEnabledForSweep();
  const results = { considered: recipients.length, sent: 0, skipped: 0, errors: 0, details: [] };

  for (const r of recipients) {
    const tz = r.default_timezone || "America/New_York";
    const due = resolveDue({
      nowUtc: now,
      tz,
      sendAtLocal: r.send_at_local,
      businessHoursEnd: r.business_hours_end || "17:00",
      includeWeekends: r.include_weekends ?? false,
      lastSentForDate: r.last_sent_for_date,
    });

    if (!due.due) {
      results.skipped += 1;
      results.details.push({ recipientId: r.id, companyId: r.company_id, sent: false, reason: due.reason, targetDate: due.targetDate });
      continue;
    }

    try {
      // companyName is looked up per-send rather than joined once — it's a
      // single cheap read and keeps listAllEnabledForSweep's join list short.
      const { rows: nameRows } = await db.query(`SELECT name FROM companies WHERE id = $1`, [r.company_id]);
      await sendForRecipient(r, { businessDate: due.targetDate, companyName: nameRows[0]?.name || "Your company", tz });
      results.sent += 1;
      results.details.push({ recipientId: r.id, companyId: r.company_id, sent: true, targetDate: due.targetDate });
    } catch (err) {
      results.errors += 1;
      logger.error("Daily report sweep: send failed", { recipientId: r.id, companyId: r.company_id, error: err.message });
      results.details.push({ recipientId: r.id, companyId: r.company_id, sent: false, error: err.message });
    }
  }
  return results;
}

module.exports = { sendForRecipient, runSweep, LEDGER_START_DATE };
