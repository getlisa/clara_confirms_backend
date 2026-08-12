/**
 * Register / inspect / remove this company's ServiceTrade webhook subscription.
 *
 * Entity filtering is deliberately narrow. `entityEvents: null` would subscribe
 * to everything ServiceTrade can push — invoices, quotes, clock events,
 * attachments — and each delivery costs us a database round-trip on the receive
 * path whether or not we act on it. We subscribe to exactly the six entity types
 * the confirmation product reads.
 *
 * includeChangesets is ON because the tracked fields land squarely on our
 * domain: Appointment `status`/`windowStart`/`windowEnd` and Job `status`. That
 * is a reschedule, a cancellation, and a job completion — told to us directly,
 * with old and new values, instead of inferred by diffing after a refetch.
 */

const config = require("../config");
const stClient = require("./servicetrade");
const credentialsDb = require("../db/servicetrade-credentials");
const webhooksDb = require("../db/servicetrade-webhooks");
const logger = require("../utils/logger");

// ServiceTrade's numeric entity-type constants (from the published Entity Types
// reference). Named here because `{entityType: 16}` in a request body is
// unreadable and a wrong number silently subscribes to the wrong thing.
const ENTITY_TYPES = {
  job: 3,
  user: 4,        // technicians arrive as User events
  company: 5,     // ServiceTrade "Company" is our customer
  location: 11,
  appointment: 16,
  contact: 22,
};

const ALL_ACTIONS = ["created", "updated", "deleted"];

function defaultEntityEvents() {
  return Object.values(ENTITY_TYPES).map((entityType) => ({ entityType, actions: ALL_ACTIONS }));
}

function hookUrlFor(secret, baseUrl = config.publicApiUrl) {
  if (!baseUrl) return null;
  return `${baseUrl.replace(/\/+$/, "")}/webhooks/servicetrade/${secret}`;
}

/**
 * Create or update the subscription so it points at our current hookUrl.
 *
 * Idempotent: if we already hold a ServiceTrade webhook id, that subscription is
 * PUT rather than a second one created. ServiceTrade allows several webhooks per
 * account and sends every message to each of them, so creating duplicates would
 * mean processing every change twice, forever, with no way to tell which
 * subscription is ours.
 *
 * PUT cannot change hookUrl (the API accepts only enabled/includeChangesets/
 * entityEvents), so a changed base URL means delete-then-create.
 */
async function register(companyId, { baseUrl = config.publicApiUrl, entityEvents = null, includeChangesets = true } = {}) {
  if (!baseUrl) {
    return { ok: false, status: 400, error: "PUBLIC_API_URL is not set — ServiceTrade needs a stable public URL to POST to" };
  }
  if (!/^https:\/\//i.test(baseUrl)) {
    // ServiceTrade requires a publicly reachable URL; localhost or http is a
    // guaranteed silent failure that would only show up as "no events ever".
    return { ok: false, status: 400, error: `Webhook base URL must be public https — got ${baseUrl}` };
  }

  const credentials = await credentialsDb.getByCompanyId(companyId);
  if (!credentials) return { ok: false, status: 400, error: "ServiceTrade not connected" };

  const subscription = await webhooksDb.ensureSubscription(companyId);
  const hookUrl = hookUrlFor(subscription.secret, baseUrl);
  const events = entityEvents || defaultEntityEvents();

  // Existing registration pointing somewhere else — remove it first, since
  // hookUrl is immutable on PUT.
  if (subscription.servicetrade_webhook_id && subscription.hook_url && subscription.hook_url !== hookUrl) {
    logger.info("ServiceTrade webhook: hookUrl changed, replacing subscription", {
      companyId, from: subscription.hook_url, to: hookUrl,
    });
    await stClient.request(companyId, "DELETE", `/webhook/${subscription.servicetrade_webhook_id}`, {}, credentials)
      .catch((err) => logger.warn("ServiceTrade webhook: delete of stale subscription failed", { companyId, error: err.message }));
    await webhooksDb.clearRegistration(companyId);
    subscription.servicetrade_webhook_id = null;
  }

  const body = { enabled: true, includeChangesets, entityEvents: events };
  const res = subscription.servicetrade_webhook_id
    ? await stClient.request(companyId, "PUT", `/webhook/${subscription.servicetrade_webhook_id}`, { body }, credentials)
    : await stClient.request(companyId, "POST", "/webhook", { body: { hookUrl, ...body } }, credentials);

  if (!res.ok) {
    const detail = res.messages?.error?.join("; ") || `HTTP ${res.status}`;
    logger.error("ServiceTrade webhook registration failed", { companyId, status: res.status, detail });
    // 403 here almost always means the connected user lacks admin.account.
    return { ok: false, status: res.status === 403 ? 403 : 502, error: `ServiceTrade rejected the webhook: ${detail}` };
  }

  const saved = await webhooksDb.saveRegistration(companyId, {
    servicetradeWebhookId: res.data?.id ?? subscription.servicetrade_webhook_id,
    hookUrl: res.data?.hookUrl ?? hookUrl,
    enabled: res.data?.enabled ?? true,
    confirmed: res.data?.confirmed ?? false,
    entityEvents: res.data?.entityEvents ?? events,
  });

  logger.info("ServiceTrade webhook registered", {
    companyId, webhookId: saved?.servicetrade_webhook_id, hookUrl: saved?.hook_url, confirmed: saved?.confirmed,
  });
  return { ok: true, subscription: publicShape(saved) };
}

async function unregister(companyId) {
  const subscription = await webhooksDb.getSubscription(companyId);
  if (!subscription?.servicetrade_webhook_id) {
    return { ok: true, removed: false };
  }
  const credentials = await credentialsDb.getByCompanyId(companyId);
  if (credentials) {
    const res = await stClient.request(companyId, "DELETE", `/webhook/${subscription.servicetrade_webhook_id}`, {}, credentials);
    // 404 means it is already gone upstream — the desired end state either way.
    if (!res.ok && res.status !== 404) {
      return { ok: false, status: 502, error: `ServiceTrade refused to delete the webhook (HTTP ${res.status})` };
    }
  }
  await webhooksDb.clearRegistration(companyId);
  return { ok: true, removed: true };
}

/**
 * Local record plus, when reachable, ServiceTrade's own view of the
 * subscription — the two can drift if someone deletes it in ServiceTrade.
 */
async function status(companyId) {
  const subscription = await webhooksDb.getSubscription(companyId);
  const queue = await webhooksDb.countsByStatus(companyId);
  if (!subscription) return { ok: true, subscription: null, queue };

  let upstream = null;
  if (subscription.servicetrade_webhook_id) {
    const credentials = await credentialsDb.getByCompanyId(companyId);
    if (credentials) {
      const res = await stClient.request(companyId, "GET", `/webhook/${subscription.servicetrade_webhook_id}`, {}, credentials);
      upstream = res.ok ? res.data : { error: `HTTP ${res.status}`, missing: res.status === 404 };
    }
  }
  return { ok: true, subscription: publicShape(subscription), upstream, queue };
}

/**
 * The secret is the credential for an unauthenticated public endpoint, so it is
 * never returned — only whether one exists, and the URL it produces (which does
 * contain it, and is therefore only ever shown to an authenticated staff user
 * who needs it to configure or debug the integration).
 */
function publicShape(row) {
  if (!row) return null;
  return {
    company_id: row.company_id,
    servicetrade_webhook_id: row.servicetrade_webhook_id,
    hook_url: row.hook_url,
    enabled: row.enabled,
    // Mirrored from ServiceTrade for display only — NOT proof the endpoint is
    // reachable. A subscription created against a domain that cannot resolve
    // reported confirmed:true one second later. Only last_message_at is evidence.
    confirmed: row.confirmed,
    entity_events: row.entity_events,
    last_message_at: row.last_message_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

module.exports = { register, unregister, status, hookUrlFor, defaultEntityEvents, ENTITY_TYPES, publicShape };
