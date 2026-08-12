/**
 * ServiceTrade webhook subscriptions + the inbound event queue.
 *
 * The receiving endpoint's whole job is enqueueEvents() — ServiceTrade allows
 * 5 seconds before it retries and, after 3 attempts, discards the message
 * permanently, so nothing else may happen on that request path. Everything
 * expensive is done later by the drain, against rows claimed here.
 */

const crypto = require("crypto");
const db = require("./index");

// 32 bytes of base64url ≈ 256 bits. This value is the ONLY authentication on
// the inbound endpoint (ServiceTrade sends no signature of any kind), and it
// ends up embedded in a URL stored on their side, so it has to be long enough
// that guessing is hopeless and URL-safe enough to survive being pasted around.
function generateSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

// ── Subscriptions ───────────────────────────────────────────────────────────

async function getSubscription(companyId) {
  const { rows } = await db.query(
    `SELECT * FROM servicetrade_webhook_subscriptions WHERE company_id = $1`,
    [companyId]
  );
  return rows[0] || null;
}

/**
 * Resolve an inbound request's URL secret to a company.
 *
 * Returns null for an unknown secret. The caller must still answer 200 — a 4xx
 * is treated by ServiceTrade as a SUCCESSFUL delivery, so refusing loudly
 * gains nothing and returning 5xx would burn the message's 3 retries.
 */
async function findBySecret(secret) {
  if (typeof secret !== "string" || secret.length < 16) return null;
  const { rows } = await db.query(
    `SELECT * FROM servicetrade_webhook_subscriptions WHERE secret = $1`,
    [secret]
  );
  return rows[0] || null;
}

/**
 * Get this company's subscription row, creating one (secret only, not yet
 * registered upstream) if absent. The secret is stable across re-registration
 * so an existing hookUrl keeps working.
 */
async function ensureSubscription(companyId) {
  const { rows } = await db.query(
    `INSERT INTO servicetrade_webhook_subscriptions (company_id, secret)
     VALUES ($1, $2)
     ON CONFLICT (company_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [companyId, generateSecret()]
  );
  return rows[0];
}

async function saveRegistration(companyId, { servicetradeWebhookId, hookUrl, enabled, confirmed, entityEvents }) {
  const { rows } = await db.query(
    `UPDATE servicetrade_webhook_subscriptions
        SET servicetrade_webhook_id = $2,
            hook_url      = $3,
            enabled       = COALESCE($4, enabled),
            confirmed     = COALESCE($5, confirmed),
            entity_events = $6::jsonb,
            updated_at    = NOW()
      WHERE company_id = $1
      RETURNING *`,
    [companyId, servicetradeWebhookId ?? null, hookUrl ?? null, enabled ?? null, confirmed ?? null,
     entityEvents ? JSON.stringify(entityEvents) : null]
  );
  return rows[0] || null;
}

async function clearRegistration(companyId) {
  await db.query(
    `UPDATE servicetrade_webhook_subscriptions
        SET servicetrade_webhook_id = NULL, hook_url = NULL, confirmed = FALSE, updated_at = NOW()
      WHERE company_id = $1`,
    [companyId]
  );
}

// ── Event queue ─────────────────────────────────────────────────────────────

/**
 * Insert one message's `data` elements.
 *
 * ON CONFLICT DO NOTHING carries the idempotency: the spec warns a message may
 * arrive "even more than once", and a retry re-sends the identical messageId
 * with the identical array. A duplicate must not re-enqueue work, and must not
 * error either — the endpoint has to answer 200 regardless.
 *
 * @returns {Promise<number>} how many rows were genuinely new
 */
async function enqueueEvents(companyId, messageId, events) {
  if (!events.length) return 0;
  const values = [];
  const params = [];
  let idx = 0;
  for (const e of events) {
    values.push(`($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb)`);
    params.push(
      companyId, messageId, e.action, e.entityType, e.entityId,
      e.entityUri ?? null, e.eventTs ?? null, e.actorUserId ?? null,
      e.changeset ? JSON.stringify(e.changeset) : null
    );
  }
  const { rowCount } = await db.query(
    `INSERT INTO servicetrade_webhook_events
       (company_id, message_id, action, entity_type, entity_id, entity_uri, event_ts, actor_user_id, changeset)
     VALUES ${values.join(", ")}
     ON CONFLICT (company_id, message_id, entity_type, entity_id, action) DO NOTHING`,
    params
  );
  await db.query(
    `UPDATE servicetrade_webhook_subscriptions SET last_message_at = NOW() WHERE company_id = $1`,
    [companyId]
  );
  return rowCount;
}

/** Companies with work waiting, so the drain cron doesn't scan every tenant. */
async function listCompaniesWithPending() {
  const { rows } = await db.query(
    `SELECT DISTINCT company_id FROM servicetrade_webhook_events WHERE status = 'pending'`
  );
  return rows.map((r) => Number(r.company_id));
}

/** How long a row may sit in 'processing' before another drain may take it. */
const STUCK_AFTER_MS = 10 * 60 * 1000;
/** Give up after this many attempts so one poisoned event can't block a company forever. */
const MAX_ATTEMPTS = 5;

/**
 * Atomically claim up to `limit` events for one company.
 *
 * FOR UPDATE SKIP LOCKED inside a single statement is what makes concurrent
 * drains safe — the every-minute cron and a manual refresh-button drain can
 * overlap, and without this they would both process the same event, firing two
 * identical ServiceTrade fetch storms.
 *
 * Also reclaims rows stranded in 'processing' by a crashed or timed-out drain
 * (a serverless invocation killed mid-flight leaves them there forever
 * otherwise), but only below MAX_ATTEMPTS so a genuinely poisonous event
 * eventually stops being retried.
 */
async function claimPending(companyId, limit = 50) {
  const { rows } = await db.query(
    `WITH claimable AS (
       SELECT id FROM servicetrade_webhook_events
        WHERE company_id = $1
          AND attempts < $3
          AND (status = 'pending'
               OR (status = 'processing' AND claimed_at < NOW() - ($4::double precision * INTERVAL '1 millisecond')))
        ORDER BY received_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE servicetrade_webhook_events e
        SET status = 'processing', attempts = e.attempts + 1, claimed_at = NOW()
       FROM claimable c
      WHERE e.id = c.id
      RETURNING e.*`,
    [companyId, limit, MAX_ATTEMPTS, STUCK_AFTER_MS]
  );
  return rows;
}

async function markDone(ids, { resolvedJobRef = null } = {}) {
  if (!ids.length) return;
  await db.query(
    `UPDATE servicetrade_webhook_events
        SET status = 'done', processed_at = NOW(), last_error = NULL,
            resolved_job_ref = COALESCE($2, resolved_job_ref)
      WHERE id = ANY($1::bigint[])`,
    [ids, resolvedJobRef]
  );
}

/**
 * markDone with a per-row resolved job ref, in one statement — the drain
 * resolves a different job for each event, and issuing one UPDATE per event
 * would put a hundred round-trips on a remote pooled connection.
 */
async function markDoneWithRefs(pairs) {
  if (!pairs.length) return;
  await db.query(
    `UPDATE servicetrade_webhook_events e
        SET status = 'done', processed_at = NOW(), last_error = NULL, resolved_job_ref = v.job_ref
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS job_ref) v
      WHERE e.id = v.id`,
    [pairs.map((p) => p.id), pairs.map((p) => String(p.jobRef))]
  );
}

/**
 * Hand an event back for another attempt, or bury it once attempts are spent.
 * Buried rows stay in the table on purpose — a 'failed' row is the only record
 * that a real CRM change was pushed to us and never applied, and the hourly
 * poll is what actually recovers the data.
 */
async function markFailed(ids, error) {
  if (!ids.length) return;
  await db.query(
    `UPDATE servicetrade_webhook_events
        SET status = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
            last_error = $2,
            processed_at = CASE WHEN attempts >= $3 THEN NOW() ELSE NULL END
      WHERE id = ANY($1::bigint[])`,
    [ids, String(error).slice(0, 1000), MAX_ATTEMPTS]
  );
}

/** Events we deliberately don't act on (entity types we don't model). */
async function markSkipped(ids, reason) {
  if (!ids.length) return;
  await db.query(
    `UPDATE servicetrade_webhook_events
        SET status = 'skipped', processed_at = NOW(), last_error = $2
      WHERE id = ANY($1::bigint[])`,
    [ids, reason]
  );
}

async function countsByStatus(companyId) {
  const { rows } = await db.query(
    `SELECT status, count(*)::int AS n FROM servicetrade_webhook_events
      WHERE company_id = $1 GROUP BY status`,
    [companyId]
  );
  return rows.reduce((acc, r) => ({ ...acc, [r.status]: r.n }), {});
}

/** Retention sweep — 'failed' rows are kept longer, being the only failure record. */
async function purgeOld({ doneOlderThanDays = 7, failedOlderThanDays = 30 } = {}) {
  const { rowCount } = await db.query(
    `DELETE FROM servicetrade_webhook_events
      WHERE (status IN ('done','skipped') AND processed_at < NOW() - ($1::int * INTERVAL '1 day'))
         OR (status = 'failed'            AND processed_at < NOW() - ($2::int * INTERVAL '1 day'))`,
    [doneOlderThanDays, failedOlderThanDays]
  );
  return rowCount;
}

module.exports = {
  generateSecret,
  getSubscription, findBySecret, ensureSubscription, saveRegistration, clearRegistration,
  enqueueEvents, listCompaniesWithPending, claimPending, markDone, markDoneWithRefs, markFailed, markSkipped,
  countsByStatus, purgeOld,
  MAX_ATTEMPTS, STUCK_AFTER_MS,
};
