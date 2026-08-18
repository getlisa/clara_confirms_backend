/**
 * Row-level data for each sheet of the daily report — one function per sheet,
 * every one scoped to (companyId, businessDate, tz). Pure reads; nothing here
 * writes anything.
 *
 * Scope: customer_confirmation only, per the agreed decision — technician
 * confirmation/reschedule calls are a different audience and would muddy the
 * "how many customers reached out" headline.
 *
 * Outcomes (confirmed/rescheduled/cancelled/created) are read EXCLUSIVELY from
 * confirmation_events (migration 097), never from appointments.customer_confirmed_at.
 * That column does exist and IS reliably stamped (unlike what an earlier pass
 * over this codebase assumed) — but every write path that sets it ALSO writes
 * the ledger in the same request, so unioning both would double-count. The
 * timestamp is used instead as a cheap cross-check in collectSummary: if the
 * two disagree, something in this report is wrong.
 */

const db = require("../../db");
const logsDb = require("../../db/logs");
const { businessDayRangeUtc } = require("./schedule");
const { toLocalDateOnly } = require("../../utils/timezone");

// Mirrors routes/retell.js's NO_ANSWER_REASONS (not exported there) — a voice
// call that never connected is not a customer who "responded".
const NO_ANSWER_REASONS = new Set([
  "dial_no_answer", "dial_busy", "dial_failed", "user_declined",
  "invalid_destination", "error_no_audio_received",
]);

/**
 * Every customer we attempted to reach this business day, any channel —
 * sourced from db/logs.js's OWN unified query (the same one the Logs page
 * renders), not re-derived from scheduled_calls. That matters for one
 * concrete reason: a manually-triggered chat link
 * (POST /chat-links/:id/send-email or /send-sms) creates NO scheduled_calls
 * row at all — a scheduled_calls-based query silently drops every manual
 * send. logs.js's chat half reads chat_links directly, so it has no such gap,
 * and it guarantees this report can never disagree with what staff see on the
 * Logs page for the same company and day.
 */
async function collectOutreach(companyId, businessDate, tz) {
  const { from, to } = businessDayRangeUtc(businessDate, tz);
  const rows = await logsDb.listForRange(companyId, { from, to, callType: "customer_confirmation" });
  return rows.map((r) => {
    const isChat = r.source === "chat";
    // record.channel: for a 'call'-source row this is the RAW value from the
    // calls table itself (voice, or a legacy Retell-hosted web_chat/sms
    // session) — distinct from the top-level `channel`, which logs.js
    // deliberately collapses to just 'call'/'chat' for the Logs page's own
    // display. The finer value is what "responded" needs to be judged right.
    const rawChannel = isChat ? "chat" : (r.record?.channel || "voice");
    return {
      channel: rawChannel,
      job_id: r.job_id,
      job_name: r.job_name,
      job_number: r.job_number,
      recipient_name: r.recipient_name,
      destination: isChat ? (r.recipient_email || r.recipient_phone) : (r.record?.to_number || r.recipient_phone),
      sent_at: r.timestamp,
      // Only meaningful for our own chat_links widget — a call (voice, or a
      // legacy Retell-hosted chat/sms session) has no separate "opened" step.
      opened: isChat ? r.record?.opened_at != null : null,
      // Best-effort, and each half measures a different thing: a call
      // "responded" if it actually connected; our own chat widget "responded"
      // if the customer opened it AND the conversation moved past its
      // starting state (rather than lapsing unanswered).
      responded: isChat
        ? (r.record?.status === "in_progress" || r.record?.status === "ended")
        : (r.record?.disconnection_reason != null && !NO_ANSWER_REASONS.has(r.record.disconnection_reason)),
    };
  });
}

/** One row per confirmed appointment (a batch confirm of 3 is 3 rows). */
async function collectConfirmed(companyId, businessDate, tz) {
  const { from, to } = businessDayRangeUtc(businessDate, tz);
  const { rows } = await db.query(
    `SELECT ce.occurred_at, ce.channel, ce.actor_name, ce.job_id, ce.appointment_id,
            j.job_number, j.title AS job_name, l.name AS location_name,
            a.scheduled_start
       FROM confirmation_events ce
       LEFT JOIN jobs j ON j.id = ce.job_id
       LEFT JOIN locations l ON l.id = j.location_id
       LEFT JOIN appointments a ON a.id = ce.appointment_id
      WHERE ce.company_id = $1 AND ce.is_test = false AND ce.event_type = 'confirmed'
        AND ce.occurred_at >= $2 AND ce.occurred_at < $3
      ORDER BY ce.occurred_at`,
    [companyId, from, to]
  );
  return rows;
}

async function collectReschedules(companyId, businessDate, tz) {
  const { from, to } = businessDayRangeUtc(businessDate, tz);
  const { rows } = await db.query(
    `SELECT ce.occurred_at, ce.channel, ce.actor_name, ce.job_id, ce.appointment_id, ce.details,
            j.job_number, j.title AS job_name, l.name AS location_name
       FROM confirmation_events ce
       LEFT JOIN jobs j ON j.id = ce.job_id
       LEFT JOIN locations l ON l.id = j.location_id
      WHERE ce.company_id = $1 AND ce.is_test = false AND ce.event_type = 'rescheduled'
        AND ce.occurred_at >= $2 AND ce.occurred_at < $3
      ORDER BY ce.occurred_at`,
    [companyId, from, to]
  );
  return rows;
}

async function collectCancellations(companyId, businessDate, tz) {
  const { from, to } = businessDayRangeUtc(businessDate, tz);
  const { rows } = await db.query(
    `SELECT ce.occurred_at, ce.channel, ce.actor_name, ce.job_id, ce.appointment_id, ce.details,
            j.job_number, j.title AS job_name, l.name AS location_name
       FROM confirmation_events ce
       LEFT JOIN jobs j ON j.id = ce.job_id
       LEFT JOIN locations l ON l.id = j.location_id
      WHERE ce.company_id = $1 AND ce.is_test = false AND ce.event_type = 'cancelled'
        AND ce.occurred_at >= $2 AND ce.occurred_at < $3
      ORDER BY ce.occurred_at`,
    [companyId, from, to]
  );
  return rows;
}

/**
 * The edge case this report exists for: outreach sent on an EARLIER day that
 * never reached an outcome. `status IN ('sent','in_progress')` is what makes
 * this self-clearing — the moment a chat is confirmed/rescheduled/cancelled it
 * becomes 'ended' and drops out of this list on its own; the moment it lapses
 * unanswered it becomes 'expired' and drops out too (that's the sweep's job,
 * not this report's). So a row here means "still genuinely open", full stop —
 * never a stale duplicate of something the other sheets already cover.
 *
 * Scoped to `sent_at < businessDate's own start` — i.e. sent on some day
 * strictly BEFORE the one this report covers, not today's outreach (that's
 * the Outreach sheet's job).
 */
async function collectAwaitingResponse(companyId, businessDate, tz) {
  const { from } = businessDayRangeUtc(businessDate, tz);
  const { rows } = await db.query(
    `SELECT cl.id, cl.sent_at, cl.status, cl.state, cl.opened_at,
            cl.recipient_name, cl.recipient_email, cl.recipient_phone,
            j.job_number, j.title AS job_name, l.name AS location_name
       FROM chat_links cl
       LEFT JOIN jobs j ON j.id = cl.job_id
       LEFT JOIN locations l ON l.id = j.location_id
      WHERE cl.company_id = $1 AND cl.call_type = 'customer_confirmation'
        AND cl.status IN ('sent', 'in_progress')
        AND cl.sent_at IS NOT NULL AND cl.sent_at < $2
      ORDER BY cl.sent_at`,
    [companyId, from]
  );
  return rows.map((r) => ({
    ...r,
    sent_date_local: toLocalDateOnly(r.sent_at, tz),
    opened: r.opened_at != null,
    age_days: Math.max(0, Math.round((Date.parse(from) - Date.parse(r.sent_at)) / 86400000)),
  }));
}

/**
 * Open/in-progress todos — a live snapshot, not date-scoped like the other
 * sheets, since an escalation stays relevant until someone resolves it. job_id
 * and a human-readable subject travel in `metadata` (todos has no job_id
 * column of its own) — see db/todos.js's create/createMissingPhone.
 */
async function collectActionItems(companyId) {
  const { rows } = await db.query(
    `SELECT t.id, t.type, t.status, t.priority, t.metadata, t.created_at,
            j.job_number, j.title AS job_name, l.name AS location_name
       FROM todos t
       LEFT JOIN jobs j ON j.id = NULLIF(regexp_replace(t.metadata->>'job_id', '[^0-9]', '', 'g'), '')::int
                        AND j.company_id = t.company_id
       LEFT JOIN locations l ON l.id = j.location_id
      WHERE t.company_id = $1 AND t.is_test = false AND t.status IN ('open', 'in_progress')
      ORDER BY (t.priority = 'high') DESC, t.created_at`,
    [companyId]
  );
  return rows;
}

/** The headline numbers, plus a cross-check against appointments' own stamp. */
async function collectSummary(companyId, businessDate, tz) {
  const { from, to } = businessDayRangeUtc(businessDate, tz);
  const [outreach, confirmed, rescheduled, cancelled, awaiting, actionItems, crossCheck] = await Promise.all([
    collectOutreach(companyId, businessDate, tz),
    collectConfirmed(companyId, businessDate, tz),
    collectReschedules(companyId, businessDate, tz),
    collectCancellations(companyId, businessDate, tz),
    collectAwaitingResponse(companyId, businessDate, tz),
    collectActionItems(companyId),
    db.query(
      `SELECT count(*)::int n FROM appointments
        WHERE company_id = $1 AND customer_confirmed_at >= $2 AND customer_confirmed_at < $3`,
      [companyId, from, to]
    ),
  ]);
  return {
    business_date: businessDate,
    outreach_count: outreach.length,
    confirmed_count: confirmed.length,
    rescheduled_count: rescheduled.length,
    cancelled_count: cancelled.length,
    awaiting_response_count: awaiting.length,
    action_items_count: actionItems.length,
    // A mismatch here means the ledger missed a write somewhere — every
    // customer_confirmed_at stamp should have a matching ledger row, since
    // both are set in the same request. Not expected to be non-zero; kept
    // as a visible guard rather than a silent assumption.
    confirmed_count_appointments_crosscheck: crossCheck.rows[0].n,
  };
}

module.exports = {
  collectSummary, collectOutreach, collectConfirmed, collectReschedules,
  collectCancellations, collectAwaitingResponse, collectActionItems,
};
