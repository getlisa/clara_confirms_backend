/**
 * Per-send log for chat links — see migrations/093.
 *
 * Written by BOTH send paths, which is the point: the dispatcher already left a
 * scheduled_calls row per send, but the manual routes left nothing, so "who sent
 * this first" was unanswerable the moment a link was re-sent.
 *
 * Every write is best-effort at the call site: a failure to log must never fail
 * the send it is describing.
 */

const db = require("./index");
const logger = require("../utils/logger");

/**
 * @param {object} args
 * @param {"email"|"sms"} args.medium
 * @param {"manual"|"scheduler"} args.origin
 * @param {string|null} args.destination  the address/number actually used
 * @param {boolean} args.ok               provider ACCEPTED it — not delivered; a
 *   carrier-blocked SMS is accepted and reported as sent, and no statusCallback
 *   exists yet, so this is the strongest claim available.
 */
async function record({
  companyId, token, chatLinkId = null, medium, destination = null,
  origin, triggeredByUserId = null, scheduledCallId = null,
  ok = true, error = null, providerMessageId = null,
}) {
  const { rows } = await db.query(
    `INSERT INTO chat_link_send_events
       (company_id, chat_link_token, chat_link_id, medium, destination,
        origin, triggered_by_user_id, triggered_by_name, scheduled_call_id,
        ok, error, provider_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,
             CASE WHEN $7::int IS NULL THEN NULL
                  ELSE (SELECT NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '')
                          FROM users u WHERE u.id = $7::int) END,
             $8,$9,$10,$11)
     RETURNING id`,
    [companyId, token, chatLinkId, medium, destination,
     origin, triggeredByUserId, scheduledCallId,
     ok, error ? String(error).slice(0, 1000) : null, providerMessageId]
  );
  return rows[0]?.id ?? null;
}

/** Never throws — a logging failure must not fail the send it describes. */
async function recordSafe(args) {
  try {
    return await record(args);
  } catch (err) {
    logger.warn("chat link send event: failed to log", { error: err.message, token: args?.token, medium: args?.medium });
    return null;
  }
}

/** Every send of one link, oldest first — the detail sheet's history. */
async function listForToken(companyId, token) {
  const { rows } = await db.query(
    `SELECT id, medium, destination, origin, triggered_by_user_id, triggered_by_name,
            scheduled_call_id, ok, error, provider_message_id, created_at
       FROM chat_link_send_events
      WHERE company_id = $1 AND chat_link_token = $2
      ORDER BY created_at, id`,
    [companyId, token]
  );
  return rows;
}

/**
 * The aggregate the monitoring list needs: how a link went out FIRST, how it
 * went out LAST, and how many times. `first_*` is what chat_links.origin cannot
 * tell you, because that column is overwritten on every send.
 */
const AGGREGATE_SQL = `
  SELECT count(*)::int                                  AS send_count,
         count(*) FILTER (WHERE NOT ok)::int             AS failed_count,
         (array_agg(origin        ORDER BY created_at, id))[1]                        AS first_origin,
         (array_agg(medium        ORDER BY created_at, id))[1]                        AS first_medium,
         (array_agg(created_at    ORDER BY created_at, id))[1]                        AS first_sent_at,
         (array_agg(origin        ORDER BY created_at DESC, id DESC))[1]              AS last_origin,
         (array_agg(medium        ORDER BY created_at DESC, id DESC))[1]              AS last_medium,
         (array_agg(destination   ORDER BY created_at DESC, id DESC))[1]              AS last_destination,
         (array_agg(triggered_by_name ORDER BY created_at DESC, id DESC))[1]          AS last_triggered_by_name,
         (array_agg(created_at    ORDER BY created_at DESC, id DESC))[1]              AS last_sent_at
    FROM chat_link_send_events e
   WHERE e.chat_link_token = cl.token`;

/**
 * Work out WHO a link was sent to, from the send log, when the link itself does
 * not say (migration 095 only snapshots forward from the moment it shipped, and
 * `recipient_contact_id` is null whenever the link went to the account's own
 * details).
 *
 * token → the last delivery → the address it went to → the contact who owns
 * that address. Successful sends are preferred over failed ones, then the most
 * recent, so this answers "who is holding this link right now".
 *
 * Matching, per the medium:
 *   - email → contacts.email, case- and whitespace-insensitive
 *   - sms   → contacts.mobile OR contacts.phone, compared as DIGITS ONLY. The
 *     send log stores E.164 (+14026201781) while contacts store whatever
 *     ServiceTrade holds ("402-620-1781"), so a literal comparison never
 *     matches. The last 10 digits are used, which is what makes a US number
 *     with and without its country code compare equal.
 *
 * Ambiguity is real and is resolved deterministically rather than arbitrarily:
 * +14026201781 matches two live contact rows — one by `phone`, one by `mobile`,
 * with names that differ ("Ashley Dahlhauser" vs "Ashley Dahl"). A texted number
 * is far more likely to BE someone's mobile, so a mobile hit outranks a phone
 * hit, and contact id breaks any remaining tie so repeated reads never disagree.
 *
 * Returns null when nothing matches — which is the honest answer, and better
 * than the account name this exists to avoid.
 */
async function resolveRecipientForToken(companyId, token) {
  // >= 10 digits on BOTH sides, or a short/garbage value would match everything
  // by suffix (right('',10) = '' equals right('',10)).
  const digits = (expr) => `regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g')`;
  const phoneMatches = (col) =>
    `(length(${digits(col)}) >= 10 AND length(${digits("ev.destination")}) >= 10
      AND right(${digits(col)}, 10) = right(${digits("ev.destination")}, 10))`;

  const { rows } = await db.query(
    `WITH ev AS (
       SELECT medium, destination
         FROM chat_link_send_events
        WHERE company_id = $1 AND chat_link_token = $2 AND destination IS NOT NULL
        -- a delivered send beats a failed one; then most recent wins
        ORDER BY ok DESC, created_at DESC, id DESC
        LIMIT 1
     )
     SELECT ev.medium, ev.destination, c.id AS contact_id,
            NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), '') AS name,
            c.email, COALESCE(c.mobile, c.phone) AS phone
       FROM ev
       LEFT JOIN LATERAL (
         SELECT ct.id, ct.first_name, ct.last_name, ct.email, ct.mobile, ct.phone,
                CASE WHEN ${phoneMatches("ct.mobile")} THEN 1 ELSE 2 END AS rank
           FROM contacts ct
          WHERE ct.company_id = $1
            AND CASE WHEN ev.medium = 'email'
                     THEN lower(TRIM(ct.email)) = lower(TRIM(ev.destination))
                     ELSE ${phoneMatches("ct.mobile")} OR ${phoneMatches("ct.phone")}
                END
          ORDER BY rank, ct.id
          LIMIT 1
       ) c ON TRUE`,
    [companyId, token]
  );

  const row = rows[0];
  if (!row) return null;                 // the link was never sent
  return {
    medium: row.medium,
    destination: row.destination,
    contactId: row.contact_id ?? null,
    name: row.name ?? null,              // null = sent somewhere we can't put a face to
    email: row.medium === "email" ? row.destination : row.email ?? null,
    phone: row.medium === "email" ? row.phone ?? null : row.destination,
  };
}

/**
 * The same "who was this sent to" resolution as resolveRecipientForToken, but as
 * a correlated scalar subquery, so a LIST view can show the name without one
 * round-trip per row. Kept beside the function it mirrors precisely so the two
 * cannot drift into disagreeing about who a link went to.
 *
 * @param {string} companyExpr SQL expression for the company id (e.g. "cl.company_id")
 * @param {string} tokenExpr   SQL expression for the link token (e.g. "cl.token")
 */
function recipientNameFromSendsSQL(companyExpr, tokenExpr) {
  const d = (e) => `regexp_replace(COALESCE(${e}, ''), '[^0-9]', '', 'g')`;
  const match = (col) =>
    `(length(${d(col)}) >= 10 AND length(${d("ev.destination")}) >= 10
      AND right(${d(col)}, 10) = right(${d("ev.destination")}, 10))`;
  return `(
    SELECT NULLIF(TRIM(CONCAT_WS(' ', c2.first_name, c2.last_name)), '')
      FROM (SELECT medium, destination
              FROM chat_link_send_events e2
             WHERE e2.company_id = ${companyExpr} AND e2.chat_link_token = ${tokenExpr}
               AND e2.destination IS NOT NULL
             ORDER BY e2.ok DESC, e2.created_at DESC, e2.id DESC
             LIMIT 1) ev
      JOIN contacts c2 ON c2.company_id = ${companyExpr}
       AND CASE WHEN ev.medium = 'email'
                THEN lower(TRIM(c2.email)) = lower(TRIM(ev.destination))
                ELSE ${match("c2.mobile")} OR ${match("c2.phone")}
           END
     ORDER BY CASE WHEN ${match("c2.mobile")} THEN 1 ELSE 2 END, c2.id
     LIMIT 1)`;
}

module.exports = {
  record, recordSafe, listForToken, resolveRecipientForToken,
  recipientNameFromSendsSQL, AGGREGATE_SQL,
};
