/**
 * The confirmation outcome ledger — see migrations/097 for why this exists:
 * appointments/chat_links/tool-call logs cannot answer "what got confirmed,
 * rescheduled or cancelled, and WHEN" after the fact, so this records it at
 * the moment it happens instead.
 *
 * Every write is best-effort at the call site (recordSafe) — a ledger failure
 * must never fail the customer's actual confirmation/reschedule/cancel.
 */

const db = require("./index");
const logger = require("../utils/logger");

/**
 * @param {object} args
 * @param {"confirmed"|"rescheduled"|"cancelled"|"created"} args.eventType
 * @param {"voice"|"chat"} args.channel
 * @param {string|null} args.actorName   who confirmed, resolved at the moment
 *   it happened — never re-looked-up later (see recipient snapshot, migration 095).
 * @param {string|null} args.source     chat_links.token, or calls.retell_call_id.
 * @param {object} [args.details]       reschedule: {from, to}; cancel: {reason, scope}.
 */
async function record({
  companyId, eventType, channel, callType = null, jobId = null, appointmentId = null,
  customerId = null, actorName = null, source = null, details = {}, isTest = false,
  occurredAt = null,
}) {
  const { rows } = await db.query(
    `INSERT INTO confirmation_events
       (company_id, occurred_at, event_type, channel, call_type, job_id,
        appointment_id, customer_id, actor_name, source, details, is_test)
     VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     RETURNING id`,
    [companyId, occurredAt, eventType, channel, callType, jobId,
     appointmentId, customerId, actorName, source, JSON.stringify(details || {}), isTest]
  );
  return rows[0]?.id ?? null;
}

/** Never throws — logging an outcome must not fail the outcome itself. */
async function recordSafe(args) {
  try {
    return await record(args);
  } catch (err) {
    logger.warn("confirmation event: failed to log", {
      error: err.message, companyId: args?.companyId, eventType: args?.eventType, source: args?.source,
    });
    return null;
  }
}

/**
 * Every real (non-test) event for one company within a UTC instant range —
 * callers resolve the business-day boundary in the company's own timezone
 * (see daily-report/schedule.js) and pass it in as [from, to).
 */
async function listForRange(companyId, { from, to, callType = null } = {}) {
  const params = [companyId, from, to];
  let filter = "";
  if (callType) { params.push(callType); filter = ` AND call_type = $${params.length}`; }
  const { rows } = await db.query(
    `SELECT id, occurred_at, event_type, channel, call_type, job_id, appointment_id,
            customer_id, actor_name, source, details, created_at
       FROM confirmation_events
      WHERE company_id = $1 AND is_test = false
        AND occurred_at >= $2 AND occurred_at < $3${filter}
      ORDER BY occurred_at`,
    params
  );
  return rows;
}

module.exports = { record, recordSafe, listForRange };
