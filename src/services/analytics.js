/**
 * Aggregate dashboard analytics. Extracted from routes/dashboard.js so both the
 * HTTP dashboard endpoint AND the copilot `analytics_summary` tool share one
 * source of truth. Every query is scoped to companyId.
 */

const db = require("./../db");
const { getCompanyTimezone, toOffsetISOString } = require("../utils/timezone");

function getPeriodStart(period) {
  switch (period) {
    case "today": return `DATE_TRUNC('day', NOW())`;
    case "week":  return `NOW() - INTERVAL '7 days'`;
    case "month": return `NOW() - INTERVAL '30 days'`;
    case "all":   return null; // no date filter
    default:      return `NOW() - INTERVAL '7 days'`;
  }
}

function normalizePeriod(period) {
  return ["today", "week", "month", "all"].includes(period) ? period : "week";
}

async function getStats(companyId, periodInput) {
  const period = normalizePeriod(periodInput);
  const periodStart = getPeriodStart(period);
  const periodFilter = periodStart ? `AND created_at >= ${periodStart}` : "";

  const [callsMain, callsByType, jobs, todos, queueMain, queueByType, quotations, customers] = await Promise.all([
    db.query(
      `SELECT
         COUNT(*)                                                           AS total,
         COUNT(*) FILTER (WHERE status = 'analyzed')                       AS analyzed,
         ROUND(
           COUNT(*) FILTER (WHERE appointment_confirmed = 'yes')::numeric /
           NULLIF(COUNT(*) FILTER (WHERE status = 'analyzed'), 0) * 100, 1
         )                                                                  AS confirmation_rate,
         ROUND(AVG(duration_ms) FILTER (WHERE status = 'analyzed'))        AS avg_duration_ms,
         COUNT(*) FILTER (WHERE appointment_confirmed = 'yes')             AS outcome_confirmed,
         COUNT(*) FILTER (WHERE appointment_confirmed = 'no')              AS outcome_not_confirmed,
         COUNT(*) FILTER (WHERE appointment_confirmed = 'unclear'
                            AND in_voicemail = false
                            AND disconnection_reason NOT IN (
                              'dial_no_answer','dial_busy','dial_failed',
                              'user_declined','invalid_destination','error_no_audio_received'
                            ))                                              AS outcome_unclear,
         COUNT(*) FILTER (WHERE in_voicemail = true
                            OR disconnection_reason = 'voicemail_reached') AS outcome_voicemail,
         COUNT(*) FILTER (WHERE disconnection_reason IN (
                            'dial_no_answer','dial_busy','dial_failed',
                            'user_declined','invalid_destination','error_no_audio_received'
                          ))                                               AS outcome_no_answer,
         COUNT(*) FILTER (WHERE user_sentiment = 'Positive')               AS sentiment_positive,
         COUNT(*) FILTER (WHERE user_sentiment = 'Neutral')                AS sentiment_neutral,
         COUNT(*) FILTER (WHERE user_sentiment = 'Negative')               AS sentiment_negative,
         COUNT(*) FILTER (WHERE user_sentiment IS NULL
                            OR user_sentiment = 'Unknown')                 AS sentiment_unknown
       FROM calls
       WHERE company_id = $1 AND is_test = false ${periodFilter}`,
      [companyId]
    ),
    db.query(
      `SELECT metadata->>'call_type' AS call_type, COUNT(*) AS cnt
       FROM calls
       WHERE company_id = $1 AND is_test = false ${periodFilter}
         AND metadata->>'call_type' IS NOT NULL
       GROUP BY metadata->>'call_type'`,
      [companyId]
    ),
    db.query(
      `SELECT
         COUNT(*)                                                                    AS total,
         COUNT(*) FILTER (WHERE scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
                            AND status NOT IN ('completed','cancelled'))             AS due_soon,
         COUNT(*) FILTER (WHERE status = 'scheduled'
                            AND NOT EXISTS (
                              SELECT 1 FROM appointments a
                              WHERE a.job_id = jobs.id AND a.customer_confirmed = true
                            ))                                                       AS unconfirmed,
         ROUND(
           COUNT(*) FILTER (WHERE status IN ('confirmed','completed'))::numeric /
           NULLIF(COUNT(*) FILTER (WHERE status != 'cancelled'), 0) * 100, 1
         )                                                                           AS confirmation_rate,
         COUNT(*) FILTER (WHERE status = 'open')                                    AS s_open,
         COUNT(*) FILTER (WHERE status = 'scheduled')                               AS s_scheduled,
         COUNT(*) FILTER (WHERE status = 'rescheduled')                             AS s_rescheduled,
         COUNT(*) FILTER (WHERE status = 'confirmed')                               AS s_confirmed,
         COUNT(*) FILTER (WHERE status = 'in_progress')                             AS s_in_progress,
         COUNT(*) FILTER (WHERE status = 'completed')                               AS s_completed,
         COUNT(*) FILTER (WHERE status = 'cancelled')                               AS s_cancelled
       FROM jobs
       WHERE company_id = $1`,
      [companyId]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'open')                                    AS open_todos,
         COUNT(*) FILTER (WHERE status = 'open' AND priority = 'high')              AS high_priority_open,
         ROUND(
           COUNT(*) FILTER (WHERE status IN ('resolved','dismissed'))::numeric /
           NULLIF(COUNT(*), 0) * 100, 1
         )                                                                           AS resolution_rate,
         COUNT(*) FILTER (WHERE type = 'NOT_PICKED')                                AS t_not_picked,
         COUNT(*) FILTER (WHERE type = 'VOICEMAIL')                                 AS t_voicemail,
         COUNT(*) FILTER (WHERE type = 'ASKED_FOR_RESCHEDULE')                      AS t_reschedule,
         COUNT(*) FILTER (WHERE type = 'ASKED_FOR_CANCELLATION')                    AS t_cancellation,
         COUNT(*) FILTER (WHERE type = 'UNCONFIRMED')                               AS t_unconfirmed
       FROM todos
       WHERE company_id = $1 AND is_test = false ${periodFilter}`,
      [companyId]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'pending')    AS pending,
         COUNT(*) FILTER (WHERE status = 'failed')     AS failed,
         ROUND(
           COUNT(*) FILTER (WHERE status = 'completed')::numeric /
           NULLIF(COUNT(*) FILTER (WHERE status IN ('completed','failed')), 0) * 100, 1
         )                                             AS dispatch_success_rate
       FROM scheduled_calls
       WHERE company_id = $1 AND is_test = false`,
      [companyId]
    ),
    db.query(
      `SELECT call_type, COUNT(*) AS cnt
       FROM scheduled_calls
       WHERE company_id = $1 AND is_test = false AND status = 'pending'
       GROUP BY call_type`,
      [companyId]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('sent','viewed'))    AS pending,
         ROUND(
           COUNT(*) FILTER (WHERE status = 'accepted')::numeric /
           NULLIF(COUNT(*) FILTER (WHERE status IN ('accepted','rejected','expired')), 0) * 100, 1
         )                                                      AS acceptance_rate,
         COUNT(*) FILTER (WHERE status = 'draft')              AS s_draft,
         COUNT(*) FILTER (WHERE status = 'sent')               AS s_sent,
         COUNT(*) FILTER (WHERE status = 'viewed')             AS s_viewed,
         COUNT(*) FILTER (WHERE status = 'accepted')           AS s_accepted,
         COUNT(*) FILTER (WHERE status = 'rejected')           AS s_rejected,
         COUNT(*) FILTER (WHERE status = 'expired')            AS s_expired
       FROM quotations
       WHERE company_id = $1`,
      [companyId]
    ),
    db.query(
      `SELECT
         COUNT(*) FILTER (WHERE c.is_active = true)  AS total_active,
         COUNT(DISTINCT j.customer_id) FILTER (
           WHERE j.scheduled_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7
             AND j.status NOT IN ('completed','cancelled')
         )                                            AS with_upcoming_jobs,
         COUNT(DISTINCT c.id) FILTER (
           WHERE EXISTS (
             SELECT 1 FROM calls ca
             JOIN todos td ON td.call_id = ca.id
             WHERE ca.company_id = $1
               AND td.status = 'open'
               AND td.is_test = false
               AND ca.to_number = c.phone
           )
         )                                            AS with_open_todos
       FROM customers c
       LEFT JOIN jobs j ON j.customer_id = c.id AND j.company_id = $1
       WHERE c.company_id = $1`,
      [companyId]
    ),
  ]);

  const c   = callsMain.rows[0];
  const j   = jobs.rows[0];
  const td  = todos.rows[0];
  const q   = queueMain.rows[0];
  const qt  = quotations.rows[0];
  const cu  = customers.rows[0];

  const byCallType = {};
  callsByType.rows.forEach((r) => { byCallType[r.call_type] = Number(r.cnt); });
  const queueByCallType = {};
  queueByType.rows.forEach((r) => { queueByCallType[r.call_type] = Number(r.cnt); });

  const tz = await getCompanyTimezone(companyId);
  return {
    period,
    generated_at: toOffsetISOString(new Date(), tz),
    calls: {
      total:             Number(c.total),
      analyzed:          Number(c.analyzed),
      confirmation_rate: c.confirmation_rate !== null ? Number(c.confirmation_rate) : null,
      avg_duration_ms:   c.avg_duration_ms !== null ? Number(c.avg_duration_ms) : null,
      outcome_breakdown: {
        confirmed:     Number(c.outcome_confirmed),
        not_confirmed: Number(c.outcome_not_confirmed),
        unclear:       Number(c.outcome_unclear),
        voicemail:     Number(c.outcome_voicemail),
        no_answer:     Number(c.outcome_no_answer),
      },
      sentiment_breakdown: {
        Positive: Number(c.sentiment_positive),
        Neutral:  Number(c.sentiment_neutral),
        Negative: Number(c.sentiment_negative),
        Unknown:  Number(c.sentiment_unknown),
      },
      by_call_type: byCallType,
    },
    jobs: {
      total:             Number(j.total),
      due_soon:          Number(j.due_soon),
      unconfirmed:       Number(j.unconfirmed),
      confirmation_rate: j.confirmation_rate !== null ? Number(j.confirmation_rate) : null,
      by_status: {
        open:        Number(j.s_open),
        scheduled:   Number(j.s_scheduled),
        rescheduled: Number(j.s_rescheduled),
        confirmed:   Number(j.s_confirmed),
        in_progress: Number(j.s_in_progress),
        completed:   Number(j.s_completed),
        cancelled:   Number(j.s_cancelled),
      },
    },
    todos: {
      open:                Number(td.open_todos),
      high_priority_open:  Number(td.high_priority_open),
      resolution_rate:     td.resolution_rate !== null ? Number(td.resolution_rate) : null,
      by_type: {
        NOT_PICKED:             Number(td.t_not_picked),
        VOICEMAIL:              Number(td.t_voicemail),
        ASKED_FOR_RESCHEDULE:   Number(td.t_reschedule),
        ASKED_FOR_CANCELLATION: Number(td.t_cancellation),
        UNCONFIRMED:            Number(td.t_unconfirmed),
      },
    },
    queue: {
      pending:               Number(q.pending),
      failed:                Number(q.failed),
      dispatch_success_rate: q.dispatch_success_rate !== null ? Number(q.dispatch_success_rate) : null,
      by_call_type:          queueByCallType,
    },
    quotations: {
      pending:         Number(qt.pending),
      acceptance_rate: qt.acceptance_rate !== null ? Number(qt.acceptance_rate) : null,
      by_status: {
        draft:    Number(qt.s_draft),
        sent:     Number(qt.s_sent),
        viewed:   Number(qt.s_viewed),
        accepted: Number(qt.s_accepted),
        rejected: Number(qt.s_rejected),
        expired:  Number(qt.s_expired),
      },
    },
    customers: {
      total_active:        Number(cu.total_active),
      with_upcoming_jobs:  Number(cu.with_upcoming_jobs),
      with_open_todos:     Number(cu.with_open_todos),
    },
  };
}

module.exports = { getStats, getPeriodStart, normalizePeriod };
