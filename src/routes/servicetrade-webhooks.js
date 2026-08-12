/**
 * Inbound ServiceTrade webhook receiver.
 *
 *   POST /webhooks/servicetrade/:secret   — PUBLIC, no auth header possible
 *
 * ServiceTrade sends NO signature, NO HMAC, NO shared secret header — verified
 * against the full published spec. The unguessable `:secret` path segment is
 * therefore the only available authentication, and it resolves to the company.
 * What limits the damage is the payload itself: it carries entity ids only, so
 * a forged message can at most make us re-fetch a real entity from ServiceTrade
 * using our own credentials. It cannot inject or overwrite data.
 *
 * ── Two hard rules, both from ServiceTrade's documented delivery behaviour ──
 *
 * 1. ANSWER WITHIN 5 SECONDS. Past that the message is retried, and after 3
 *    attempts it is DISCARDED PERMANENTLY. So this handler does one INSERT and
 *    returns; the drain does the fetching afterwards. Nothing may be added to
 *    this path that talks to ServiceTrade or does per-entity work.
 *
 * 2. NEVER RETURN 4xx. Any status in 200-499 counts as a successful delivery,
 *    so a 404 or 403 does not get retried — it silently throws the event away.
 *    An unknown secret, a malformed body, an unmodelled entity type: all answer
 *    200 and are logged. The only status worth returning otherwise is 5xx, and
 *    only when a retry could genuinely help (our database being down), because
 *    retries are capped at 3.
 */

const express = require("express");
const webhooksDb = require("../db/servicetrade-webhooks");
const logger = require("../utils/logger");

const router = express.Router();

// Entity types we model locally. Anything else (invoice, quote, clockevent,
// attachment, deficiency…) is recorded as 'skipped' rather than dropped, so
// turning one on later is a code change and not an archaeology exercise.
const HANDLED_ENTITY_TYPES = new Set(["job", "appointment", "contact", "location", "company", "user"]);

// A single message legitimately batches many entities, but an unbounded array
// from an unauthenticated endpoint is a memory and insert-size risk.
const MAX_EVENTS_PER_MESSAGE = 500;

/**
 * ServiceTrade sends unix SECONDS — `timestamp: 1401833052` per entity, and
 * confusingly a STRING at the message level (`"timestamp": "1401833057"`).
 * Milliseconds would land in 1970, which would then look like an ancient event
 * to anything ordering on event_ts.
 */
function toDate(unixSeconds) {
  const n = Number(unixSeconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

/**
 * Pull the fields we store out of one `data` element, or null if it isn't
 * usable. Shape per the spec:
 *   { action, timestamp, userId, entity: { type, id, uri }, changeset? }
 */
function parseEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const action = typeof raw.action === "string" ? raw.action.toLowerCase() : null;
  if (!["created", "updated", "deleted"].includes(action)) return null;

  const entity = raw.entity;
  if (!entity || typeof entity !== "object") return null;
  const entityType = typeof entity.type === "string" ? entity.type.toLowerCase() : null;
  const entityId = Number(entity.id);
  if (!entityType || !Number.isInteger(entityId) || entityId <= 0) return null;

  return {
    action,
    entityType,
    entityId,
    entityUri: typeof entity.uri === "string" ? entity.uri.slice(0, 500) : null,
    eventTs: toDate(raw.timestamp),
    // null when a system process rather than a person made the change.
    actorUserId: Number.isInteger(Number(raw.userId)) && Number(raw.userId) > 0 ? Number(raw.userId) : null,
    // Only present on `updated` with includeChangesets on. Tracked fields are
    // narrow but land squarely on our domain: appointment status/windowStart/
    // windowEnd, job status.
    changeset: Array.isArray(raw.changeset) ? raw.changeset : null,
  };
}

router.post("/:secret", async (req, res) => {
  const startedAt = Date.now();
  // Answer first, think later — literally. Everything below is written so the
  // response can be sent from any branch in a couple of milliseconds.
  const ack = (outcome, extra = {}) => {
    logger.info("ServiceTrade webhook received", { outcome, ms: Date.now() - startedAt, ...extra });
    return res.status(200).json({ received: true });
  };

  let subscription;
  try {
    subscription = await webhooksDb.findBySecret(req.params.secret);
  } catch (err) {
    // Our database is unreachable. This is the one case where a retry helps, so
    // it is the one case that gets a 5xx — the event is genuinely not stored.
    logger.error("ServiceTrade webhook: subscription lookup failed", { error: err.message });
    return res.status(503).json({ received: false });
  }

  if (!subscription) {
    // Either a stale hookUrl from a deleted subscription or someone probing.
    // 200 regardless: a 4xx would not stop it, and a 5xx would waste retries.
    return ack("unknown_secret");
  }

  const body = req.body;
  const messageId = body?.messageId;
  if (typeof messageId !== "string" || !messageId) return ack("no_message_id", { companyId: subscription.company_id });
  if (!Array.isArray(body?.data)) return ack("no_data_array", { companyId: subscription.company_id, messageId });

  const truncated = body.data.length > MAX_EVENTS_PER_MESSAGE;
  const parsed = body.data.slice(0, MAX_EVENTS_PER_MESSAGE).map(parseEvent).filter(Boolean);
  const handled = parsed.filter((e) => HANDLED_ENTITY_TYPES.has(e.entityType));

  if (truncated) {
    // Loud, because this means we are dropping real changes on the floor.
    logger.error("ServiceTrade webhook: message truncated — events dropped", {
      companyId: subscription.company_id, messageId,
      received: body.data.length, cap: MAX_EVENTS_PER_MESSAGE,
    });
  }

  if (handled.length === 0) {
    return ack("nothing_to_enqueue", {
      companyId: subscription.company_id, messageId,
      received: body.data.length, parsed: parsed.length,
    });
  }

  try {
    const inserted = await webhooksDb.enqueueEvents(subscription.company_id, messageId, handled);
    return ack("enqueued", {
      companyId: subscription.company_id, messageId,
      received: body.data.length, enqueued: inserted, duplicates: handled.length - inserted,
    });
  } catch (err) {
    logger.error("ServiceTrade webhook: enqueue failed", {
      companyId: subscription.company_id, messageId, error: err.message,
    });
    // Same reasoning as the lookup failure: nothing was stored, so a retry is
    // the only thing that can save this event.
    return res.status(503).json({ received: false });
  }
});

module.exports = router;
module.exports.HANDLED_ENTITY_TYPES = HANDLED_ENTITY_TYPES;
module.exports.MAX_EVENTS_PER_MESSAGE = MAX_EVENTS_PER_MESSAGE;
module.exports.parseEvent = parseEvent;
