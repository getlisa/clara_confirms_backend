const crypto = require("crypto");
const db = require("./index");
const sendEvents = require("./chat-link-send-events");
const { searchClause } = require("./calls");

function generateToken() {
  return crypto.randomBytes(24).toString("hex"); // 48 hex chars — unguessable
}

// recipientContactId (null = the customer themselves) scopes the lookup to
// THAT recipient's token — same COALESCE(x, 0) convention as
// scheduled_calls_active_uniq (migration 081), so "the customer's" link and
// "contact #8842's" link never cross-serve or get treated as duplicates of
// each other.
async function findByAppointment(companyId, appointmentId, recipientContactId = null) {
  const result = await db.query(
    `SELECT * FROM chat_links
     WHERE company_id = $1 AND appointment_id = $2 AND (expires_at IS NULL OR expires_at > NOW())
       AND COALESCE(recipient_contact_id, 0) = COALESCE($3, 0)
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, appointmentId, recipientContactId]
  );
  return result.rows[0] || null;
}

async function findByJob(companyId, jobId, recipientContactId = null) {
  const result = await db.query(
    `SELECT * FROM chat_links
     WHERE company_id = $1 AND job_id = $2 AND appointment_id IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
       AND COALESCE(recipient_contact_id, 0) = COALESCE($3, 0)
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, jobId, recipientContactId]
  );
  return result.rows[0] || null;
}

async function create({ companyId, jobId = null, appointmentId = null, callType = "customer_confirmation", expiresAt = null, recipientContactId = null }) {
  // Collision probability with 24 random bytes is negligible, but retry once
  // defensively rather than surface a 500 on the 1-in-2^192 case.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await db.query(
        `INSERT INTO chat_links (company_id, token, job_id, appointment_id, call_type, expires_at, recipient_contact_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [companyId, generateToken(), jobId, appointmentId, callType, expiresAt, recipientContactId]
      );
      return result.rows[0];
    } catch (err) {
      if (err.code === "23505" && attempt < 2) continue; // unique violation on token — retry
      throw err;
    }
  }
}

async function getByToken(token) {
  const result = await db.query(`SELECT * FROM chat_links WHERE token = $1`, [token]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  return row;
}

/**
 * Same lookup, but doesn't hide an expired row — lets the caller (the public
 * widget route) tell "never existed" (404) apart from "existed, but the link
 * died" (410), which reads very differently to a customer clicking a stale
 * text/email.
 */
async function getByTokenRaw(token) {
  const result = await db.query(`SELECT * FROM chat_links WHERE token = $1`, [token]);
  return result.rows[0] || null;
}

/**
 * The customer opened the link.
 *
 * `last_opened_at` moves every time (it is "most recent view"). The lifecycle
 * status advances only on the FIRST open — `status = 'sent'` — so a customer
 * re-opening a finished conversation cannot drag it back from `ended`, and
 * `opened_at` keeps meaning "when they first looked".
 */
async function markOpened(id) {
  await db.query(
    `UPDATE chat_links
        SET last_opened_at = NOW(),
            status    = CASE WHEN status = 'sent' THEN 'in_progress' ELSE status END,
            opened_at = COALESCE(opened_at, NOW())
      WHERE id = $1`,
    [id]
  );
}

/**
 * The conversation reached an outcome and the agent closed it.
 *
 * Terminal: reachable from any status, and nothing moves a row out of it — an
 * `ended` chat whose 24h link later lapses must never be reported as expired.
 */
async function markEnded(token) {
  const { rows } = await db.query(
    `UPDATE chat_links
        SET status = 'ended', ended_at = COALESCE(ended_at, NOW())
      WHERE token = $1 AND status <> 'ended'
      RETURNING id`,
    [token]
  );
  return rows.length > 0;
}

/**
 * Record WHO triggered this send and how it was triggered.
 *
 * `origin` reflects the MOST RECENT send, not the link's creation: a link a
 * staff member copied by hand and the scheduler later dispatched has been sent
 * by the scheduler, and "who sent it" should say so. Both paths stamp it.
 *
 * The sender's name is snapshotted at write time rather than joined at read
 * time — this is an audit trail, so it should keep saying who clicked even if
 * that person is later renamed or deactivated.
 */
async function setOrigin(token, { origin, userId = null }) {
  await db.query(
    `UPDATE chat_links
        SET origin = $2,
            triggered_by_user_id = $3,
            triggered_by_name = CASE
              WHEN $3::int IS NULL THEN NULL
              ELSE (SELECT NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '')
                      FROM users u WHERE u.id = $3::int)
            END
      WHERE token = $1`,
    [token, origin, userId]
  );
}

/**
 * Snapshot WHO this link was shared with, at the moment it went out.
 *
 * `name` must be a PERSON's name or null — only ever a contacts row. The
 * customer record is an account in this data model (every customer on the
 * platform has first_name/last_name NULL and a full_name like "Holiday Inn
 * Express-NE City"), so passing it here would hand the agent an organisation to
 * greet as a human. Email/phone have no such constraint: the account's own
 * address is a perfectly good destination.
 *
 * Latest-wins, like `origin` — a link is reused across re-sends and the question
 * is who the last delivery was addressed to. Written by every send path so the
 * conversation greets exactly who the email/SMS did.
 *
 * Per-field: an ABSENT key is left alone, an explicit `null` clears. The manual
 * send-email / send-sms routes each know only their own medium, so a
 * whole-row overwrite there would blank whichever address the other leg had
 * already recorded. `null` still has to mean something distinct from "unknown",
 * though — a link re-sent to the account after previously going to a named
 * contact must lose that name rather than keep greeting someone who is no
 * longer on the other end.
 */
async function setRecipient(token, fields = {}) {
  const columns = { name: "recipient_name", email: "recipient_email", phone: "recipient_phone" };
  const sets = [];
  const params = [token];
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in fields)) continue;
    params.push(fields[key] ?? null);
    sets.push(`${column} = $${params.length}`);
  }
  if (!sets.length) return;
  await db.query(`UPDATE chat_links SET ${sets.join(", ")} WHERE token = $1`, params);
}

/** Stamp the moment the link was actually delivered (email/SMS dispatch). */
async function markSent(token) {
  await db.query(
    `UPDATE chat_links SET sent_at = COALESCE(sent_at, NOW()) WHERE token = $1`,
    [token]
  );
}

/**
 * Sweep links whose 24h window lapsed without an outcome.
 *
 * Scoped to 'sent' and 'in_progress' ONLY. A half-finished conversation the
 * customer walked away from is exactly what this is for — but one that already
 * confirmed is finished business, and rewriting it to 'expired' would both lose
 * the outcome and misreport the day's numbers.
 *
 * @returns {Promise<number>} rows expired
 */
async function expireStale() {
  const { rows } = await db.query(
    `UPDATE chat_links
        SET status = 'expired', expired_at = NOW()
      WHERE expires_at IS NOT NULL
        AND expires_at < NOW()
        AND status IN ('sent', 'in_progress')
      RETURNING id, token, company_id, job_id, state`
  );
  // Returns the rows, not just a count: a conversation that reached an outcome
  // and was then abandoned needs its CRM comment posted at this moment, and the
  // caller cannot find those links again afterwards — the sweep only ever looks
  // at 'sent'/'in_progress', which these no longer are.
  return rows;
}

/** Stamped once, when an expired link's outcome comment has been written. */
async function markOutcomeCommentPosted(token) {
  await db.query(
    `UPDATE chat_links
        SET outcome_comment_posted_at = COALESCE(outcome_comment_posted_at, NOW())
      WHERE token = $1`,
    [token]
  );
}

/**
 * Expired links that may still owe a CRM comment — the one-off catch-up for
 * links that expired before this existed. The sweep cannot find them: their
 * status is already 'expired'.
 */
async function listExpiredAwaitingOutcomeComment({ companyId = null, limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT id, token, company_id, job_id, state
       FROM chat_links
      WHERE status = 'expired'
        AND outcome_comment_posted_at IS NULL
        ${companyId ? "AND company_id = $2" : ""}
      ORDER BY created_at DESC
      LIMIT $1`,
    companyId ? [limit, companyId] : [limit]
  );
  return rows;
}

/**
 * Monitoring read: one row per chat link with where it stands, newest first.
 * Joined to the job so an operator sees what the link is ABOUT, not a token.
 */
async function listForMonitoring(companyId, { status = null, limit = 50, offset = 0, search = null } = {}) {
  const params = [companyId, limit, offset];
  let i = 4;
  let filter = "";
  if (status) { filter += ` AND cl.status = $${i++}`; params.push(status); }
  if (search && String(search).trim()) {
    // Same four fields and the same digits-only phone rule as GET /calls, so the
    // two endpoints agree on what "matches" — the Logs page merges them and a
    // disagreement would look like missing rows.
    const { clause, values } = searchClause(String(search).trim(), i, {
      // MUST match the expression the row DISPLAYS, or a number visible in the
      // table fails to match when typed into the search box.
      phoneExpr: "COALESCE(sc.phone_number, ct.phone, ct.mobile)",
      textExprs: ["cu.full_name", "ct.email", "l.name"],
    });
    filter += ` AND ${clause}`;
    params.push(...values);
    i += values.length;
  }

  const { rows } = await db.query(
    `SELECT cl.id, cl.status, cl.state, cl.call_type,
            cl.created_at, cl.sent_at, cl.opened_at, cl.ended_at, cl.expired_at,
            cl.last_opened_at, cl.expires_at,
            cl.job_id, cl.appointment_id,
            j.title AS job_name, j.job_number,
            COALESCE(NULLIF(TRIM(cu.full_name), ''), TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name))) AS customer_name,
            l.name AS location_name,
            COALESCE(
            cl.recipient_name,
            NULLIF(TRIM(CONCAT_WS(' ', ct.first_name, ct.last_name)), ''),
            -- Fallback: nobody was nominated, so work backwards from the
            -- delivery — the address the email/SMS went to identifies the
            -- contact who owns it. Names 8 of 10 live links that are
            -- otherwise anonymous.
            ${sendEvents.recipientNameFromSendsSQL('cl.company_id', 'cl.token')}
            ) AS recipient_name,
            -- The medium that actually carried the link, from the dispatcher's
            -- own record. NULL for a hand-copied link with no dispatch — the UI
            -- shows "Not recorded" rather than assuming 'email', since a wrong
            -- medium is worse than an admitted gap.
            sc.link_delivery,
            cl.origin, cl.triggered_by_user_id, cl.triggered_by_name,
            cl.outcome_comment_posted_at,
            -- Prefer the address the dispatcher actually used. recipient_email is
            -- NULL on every real row; the address travels in
            -- call_context.override_email, because ServiceTrade-synced customers
            -- rarely have an email on the customer record itself.
            COALESCE(sc.recipient_email, sc.call_context->>'override_email', ct.email) AS recipient_email,
            -- contacts.phone is null on 820 of 5,828 real rows with the actual
            -- number in mobile, so falling back is the difference between
            -- showing a destination and showing nothing.
            COALESCE(sc.phone_number, ct.phone, ct.mobile) AS recipient_phone
       FROM chat_links cl
       LEFT JOIN jobs j       ON j.id  = cl.job_id
       LEFT JOIN customers cu ON cu.id = j.customer_id
       LEFT JOIN locations l  ON l.id  = j.location_id
       LEFT JOIN contacts ct  ON ct.id = cl.recipient_contact_id
       -- ONE dispatch per link. A plain LEFT JOIN on chat_link_token fans out:
       -- a link that was re-sent or retried has several scheduled_calls rows —
       -- 16 for one real token — which multiplied every link into duplicate
       -- rows and inflated the total (5 links reported as 17). The latest dispatch
       -- is the one that describes how the link most recently went out.
       LEFT JOIN LATERAL (
         SELECT s.link_delivery, s.phone_number, s.recipient_email, s.call_context
           FROM scheduled_calls s
          WHERE s.chat_link_token = cl.token
          ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
          LIMIT 1
       ) sc ON TRUE
      WHERE cl.company_id = $1 ${filter}
      ORDER BY cl.created_at DESC
      LIMIT $2 OFFSET $3`,
    params
  );

  // The count must apply the SAME joins and filters as the list, or a searched
  // page reports a total for the unsearched set and pagination walks off the end.
  const countParams = params.slice(0, 1).concat(params.slice(3));
  const { rows: totalRows } = await db.query(
    `SELECT count(*)::int AS n
       FROM chat_links cl
       LEFT JOIN jobs j       ON j.id  = cl.job_id
       LEFT JOIN customers cu ON cu.id = j.customer_id
       LEFT JOIN locations l  ON l.id  = j.location_id
       LEFT JOIN contacts ct  ON ct.id = cl.recipient_contact_id
       -- ONE dispatch per link. A plain LEFT JOIN on chat_link_token fans out:
       -- a link that was re-sent or retried has several scheduled_calls rows —
       -- 16 for one real token — which multiplied every link into duplicate
       -- rows and inflated the total (5 links reported as 17). The latest dispatch
       -- is the one that describes how the link most recently went out.
       LEFT JOIN LATERAL (
         SELECT s.link_delivery, s.phone_number, s.recipient_email, s.call_context
           FROM scheduled_calls s
          WHERE s.chat_link_token = cl.token
          ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
          LIMIT 1
       ) sc ON TRUE
      WHERE cl.company_id = $1 ${filter.replace(/\$(\d+)/g, (_, n) => `$${Number(n) - 2}`)}`,
    countParams
  );
  return { rows, total: totalRows[0].n };
}

/**
 * Company-scoped fetch by numeric id — for staff routes, which must never take
 * the token in a URL (it is the customer's credential for that conversation).
 */
async function getByIdForCompany(companyId, id) {
  const { rows } = await db.query(
    `SELECT * FROM chat_links WHERE id = $1 AND company_id = $2`, [id, companyId]);
  return rows[0] || null;
}

/** Monitoring read: current lifecycle counts for a company. */
async function statusCounts(companyId) {
  const { rows } = await db.query(
    `SELECT status, count(*)::int AS n FROM chat_links WHERE company_id = $1 GROUP BY status`,
    [companyId]
  );
  const out = { sent: 0, in_progress: 0, ended: 0, expired: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

async function getByRetellChatId(chatId) {
  const result = await db.query(`SELECT * FROM chat_links WHERE retell_chat_id = $1`, [chatId]);
  return result.rows[0] || null;
}

/**
 * Atomically claim retell_chat_id for a link that doesn't have one yet.
 * Returns the updated row if this call won the race, or null if another
 * concurrent request already claimed it first (caller should then re-fetch
 * by token and use whatever chat_id won).
 */
async function claimRetellChatId(id, chatId) {
  const result = await db.query(
    `UPDATE chat_links SET retell_chat_id = $1 WHERE id = $2 AND retell_chat_id IS NULL RETURNING *`,
    [chatId, id]
  );
  return result.rows[0] || null;
}

/**
 * Base62 short code for the /c/<code> redirect used in SMS.
 *
 * 10 chars from 60 bits of entropy. Short enough that the shortened form stays
 * cheap, but the endpoint is public and unauthenticated and resolves to a live
 * chat token, so it must be no more guessable than the token itself.
 */
const CODE_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
function generateShortCode(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

/**
 * Claim a short code for this link, if it doesn't already have one.
 *
 * Same compare-and-swap as claimRetellChatId: null means a concurrent send won
 * the race, and the caller should re-fetch and use the code that landed. Two
 * dispatch workers handling the same link must never mint two codes — the
 * second would be a second public entry point to the same conversation.
 */
async function claimShortCode(id, code) {
  const result = await db.query(
    `UPDATE chat_links SET short_code = $1 WHERE id = $2 AND short_code IS NULL RETURNING *`,
    [code, id]
  );
  return result.rows[0] || null;
}

/** Cache the shortener's answer so a resend or retry doesn't call it again. */
async function setShortUrl(id, shortUrl) {
  const result = await db.query(
    `UPDATE chat_links SET short_url = $1 WHERE id = $2 RETURNING *`,
    [shortUrl, id]
  );
  return result.rows[0] || null;
}

/**
 * Resolve a short code. Returns the row even when expired — the redirect route
 * needs to tell "expired" from "never existed", exactly as getByTokenRaw does
 * for tokens.
 */
async function getByShortCode(code) {
  const result = await db.query(`SELECT * FROM chat_links WHERE short_code = $1`, [code]);
  return result.rows[0] || null;
}

async function setState(chatId, state) {
  const result = await db.query(
    `UPDATE chat_links SET state = $1 WHERE retell_chat_id = $2 RETURNING *`,
    [state, chatId]
  );
  return result.rows[0] || null; // null is expected/harmless for voice/SMS calls (no matching row)
}

/**
 * Same as setState, but keyed by the link's own token — the confirmation
 * agent's thread_id IS the token directly (it never sets retell_chat_id).
 */
async function setStateByToken(token, state) {
  const result = await db.query(
    `UPDATE chat_links SET state = $1 WHERE token = $2 RETURNING *`,
    [state, token]
  );
  return result.rows[0] || null;
}

/**
 * Atomically swap in a fresh chat_id for a link whose previous Retell session
 * can no longer accept new turns (ended/errored), resetting state back to
 * chat_started for the new session. Compare-and-swap on the OLD chat_id, same
 * pattern as claimRetellChatId, so two concurrent reopens of the same dead
 * session only leave one live replacement behind.
 */
async function reopen(id, oldChatId, newChatId) {
  const result = await db.query(
    `UPDATE chat_links SET retell_chat_id = $1, state = 'chat_started'
     WHERE id = $2 AND retell_chat_id = $3 RETURNING *`,
    [newChatId, id, oldChatId]
  );
  return result.rows[0] || null;
}

module.exports = {
  markEnded,
  markSent,
  setOrigin,
  expireStale,
  markOutcomeCommentPosted,
  listExpiredAwaitingOutcomeComment,
  statusCounts,
  getByIdForCompany,
  listForMonitoring,
  findByAppointment, findByJob, create, getByToken, getByTokenRaw, markOpened,
  getByRetellChatId, claimRetellChatId, setState, setStateByToken, reopen, setRecipient,
  generateShortCode, claimShortCode, setShortUrl, getByShortCode,
};
