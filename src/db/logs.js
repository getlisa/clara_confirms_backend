/**
 * Unified activity log — calls and chat links as ONE ordered, paginated list.
 *
 * Why this exists rather than merging client-side: two independently-paginated
 * sources cannot be merged into a correctly-paginated list. Page 2 of a merge of
 * two separate `LIMIT 50` queries is not the continuation of page 1, so the
 * Logs page had to fetch a fixed window per source and page over that — leaving
 * older activity unreachable however you filtered, and reporting a count of the
 * window rather than of what exists.
 *
 * One UNION ALL with a computed `source` and shared aliases, ordered once. No
 * new table, and each source keeps its own record nested so the detail view
 * still has the call transcript and the chat-link timestamps.
 *
 * Deliberately NOT done: a shared status vocabulary. A call's outcome
 * (confirmed / voicemail) and a chat link's lifecycle (sent / in_progress /
 * ended / expired) are different axes; collapsing them into one enum would
 * destroy information the UI renders per source.
 */

const db = require("./index");
const sendEvents = require("./chat-link-send-events");
const { searchClause } = require("./calls");

/**
 * Both halves of the union expose the same shared columns, so the outer query
 * can order and page over them without knowing which source a row came from.
 *
 * `scheduled_calls.job_id` is VARCHAR while `jobs.id` is INTEGER and can hold
 * non-numeric refs, so the join strips to digits and NULLIFs the empty result —
 * a bare cast throws on the first TEST-SO-1 row.
 */
function callSelect(where) {
  return `
    SELECT 'call'::text AS source,
           c.id, c.created_at AS timestamp,
           CASE WHEN c.channel IN ('web_chat', 'sms') THEN 'chat' ELSE 'call' END AS channel,
           sc.job_id, sc.appointment_id, sc.job_name, NULL::text AS job_number,
           cu.full_name AS customer_name, l.name AS location_name,
           NULL::text AS recipient_name, c.to_number AS recipient_phone, cu.email AS recipient_email,
           (to_jsonb(c.*) - 'transcript' - 'raw_analysis')
             || jsonb_build_object('origin', sc.origin,
                                   'triggered_by_name', sc.triggered_by_name,
                                   'call_type', sc.call_type) AS record
      FROM calls c
      LEFT JOIN customers cu ON cu.company_id = c.company_id AND cu.phone = c.to_number
      LEFT JOIN scheduled_calls sc ON sc.retell_call_id = c.retell_call_id
      LEFT JOIN jobs j ON j.company_id = c.company_id
                      AND j.id = NULLIF(regexp_replace(COALESCE(sc.job_id, ''), '[^0-9]', '', 'g'), '')::int
      LEFT JOIN locations l ON l.id = j.location_id
     WHERE ${where}`;
}

function chatSelect(where) {
  return `
    SELECT 'chat'::text AS source,
           cl.id, cl.created_at AS timestamp,
           'chat'::text AS channel,
           cl.job_id::text AS job_id, cl.appointment_id, j.title AS job_name, j.job_number,
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
           COALESCE(sc.phone_number, ct.phone, ct.mobile) AS recipient_phone,
           COALESCE(sc.recipient_email, sc.call_context->>'override_email', ct.email) AS recipient_email,
           -- The send record travels in the nested chat_link object, where the
           -- detail sheet reads it; link_delivery lives on the dispatch, not the link.
           (to_jsonb(cl.*) - 'token' - 'short_code' - 'short_url')
             || jsonb_build_object('link_delivery', sc.link_delivery) AS record
      FROM chat_links cl
      LEFT JOIN jobs j       ON j.id  = cl.job_id
      LEFT JOIN customers cu ON cu.id = j.customer_id
      LEFT JOIN locations l  ON l.id  = j.location_id
      LEFT JOIN contacts ct  ON ct.id = cl.recipient_contact_id
      -- ONE dispatch per link — see db/chat-links.js. A plain join fans a
      -- re-sent link into duplicate log rows.
      LEFT JOIN LATERAL (
        SELECT s.link_delivery, s.phone_number, s.recipient_email, s.call_context
          FROM scheduled_calls s
         WHERE s.chat_link_token = cl.token
         ORDER BY s.updated_at DESC NULLS LAST, s.id DESC
         LIMIT 1
      ) sc ON TRUE
     WHERE ${where}`;
}

/**
 * @param {object} opts
 * @param {"call"|"chat"|null} [opts.channel]  restrict to one channel
 * @param {string|null} [opts.status]          chat lifecycle status (chat rows only)
 * @param {string|null} [opts.state]           chat conversation state (chat rows only)
 * @param {string|null} [opts.outcome]         call appointment_confirmed (call rows only)
 * @param {string|null} [opts.search]          free text over phone/email/location/customer
 * @param {boolean} [opts.isTest]              test-mode calls; chat links are EXCLUDED when true
 */
async function list(companyId, {
  channel = null, status = null, state = null, outcome = null,
  search = null, isTest = false, limit = 50, offset = 0,
} = {}) {
  // Which halves participate is decided BEFORE any parameter is bound: a
  // filter that only one source has excludes the other, and binding the
  // excluded half's parameters anyway leaves an unreferenced placeholder that
  // Postgres rejects with "could not determine data type of parameter".
  //
  // `outcome` is call-only and `status`/`state` are chat-only, so filtering on
  // one implicitly drops the other — a row that cannot satisfy the filter must
  // not appear. isTest is calls-only: chat_links has no test flag, and listing
  // real links beside test calls would misrepresent both.
  const wantCall = channel !== "chat" && !status && !state;
  const wantChat = channel !== "call" && !outcome && !isTest;

  if (!wantCall && !wantChat) {
    return { rows: [], counts: { call: 0, chat: 0 }, total: 0 };
  }

  const params = [companyId];
  let i = 2;
  const halves = [];

  if (wantCall) {
    const where = ["c.company_id = $1", `c.is_test = $${i++}`];
    params.push(isTest);
    if (outcome) { where.push(`c.appointment_confirmed = $${i++}`); params.push(outcome); }
    if (search && String(search).trim()) {
      const cs = searchClause(String(search).trim(), i, {
        phoneExpr: "c.to_number",
        textExprs: ["cu.full_name", "cu.email", "l.name"],
      });
      where.push(cs.clause);
      params.push(...cs.values);
      i += cs.values.length;
    }
    halves.push(callSelect(where.join(" AND ")));
  }

  if (wantChat) {
    const where = ["cl.company_id = $1"];
    if (status) { where.push(`cl.status = $${i++}`); params.push(status); }
    if (state) { where.push(`cl.state = $${i++}`); params.push(state); }
    if (search && String(search).trim()) {
      const cs = searchClause(String(search).trim(), i, {
        // MUST match the expression the row DISPLAYS, or a number visible in the
      // table fails to match when typed into the search box.
      phoneExpr: "COALESCE(sc.phone_number, ct.phone, ct.mobile)",
        textExprs: ["cu.full_name", "ct.email", "l.name"],
      });
      where.push(cs.clause);
      params.push(...cs.values);
      i += cs.values.length;
    }
    halves.push(chatSelect(where.join(" AND ")));
  }

  const union = halves.join("\n    UNION ALL\n");

  const listParams = params.concat([limit, offset]);
  const { rows } = await db.query(
    `WITH merged AS (${union})
     SELECT * FROM merged ORDER BY timestamp DESC, source, id DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    listParams
  );

  const { rows: countRows } = await db.query(
    `WITH merged AS (${union})
     SELECT source, count(*)::int AS n FROM merged GROUP BY source`,
    params
  );
  const counts = { call: 0, chat: 0 };
  for (const r of countRows) counts[r.source] = r.n;

  return { rows, counts, total: counts.call + counts.chat };
}

/**
 * Every log row (both sources) inside a UTC instant range — for the daily
 * report, which needs a whole business day, not a page. Reuses the SAME
 * callSelect/chatSelect the Logs page itself is built from, for one reason:
 * the report's "who did we reach out to" must never be able to disagree with
 * what staff see on the Logs page for the same company and day.
 *
 * This also closes a real gap a scheduled_calls-only query has: a MANUALLY
 * triggered chat link (POST /chat-links/:id/send-email, /send-sms) creates NO
 * scheduled_calls row at all (see db/chat-link-send-events.js) — so counting
 * "outreach" from scheduled_calls silently drops every manual send. chatSelect
 * sources from chat_links directly and has no such gap.
 *
 * `callType` filters BOTH halves to one call_type (e.g. 'customer_confirmation',
 * to exclude technician calls) — call-side via the joined scheduled_calls row
 * (a call_analyzed webhook has no call_type of its own), chat-side via
 * chat_links.call_type directly.
 */
async function listForRange(companyId, { from, to, callType = null } = {}) {
  const params = [companyId, from, to];
  const callWhere = ["c.company_id = $1", "c.is_test = false", "c.created_at >= $2", "c.created_at < $3"];
  const chatWhere = ["cl.company_id = $1", "cl.created_at >= $2", "cl.created_at < $3"];
  if (callType) {
    params.push(callType);
    // Same placeholder referenced from both halves of the UNION — this is one
    // combined query text executed once, so a parameter can appear in both.
    callWhere.push(`sc.call_type = $${params.length}`);
    chatWhere.push(`cl.call_type = $${params.length}`);
  }
  const union = [callSelect(callWhere.join(" AND ")), chatSelect(chatWhere.join(" AND "))].join("\n    UNION ALL\n");
  const { rows } = await db.query(
    `WITH merged AS (${union}) SELECT * FROM merged ORDER BY timestamp`,
    params
  );
  return rows;
}

module.exports = { list, listForRange };
