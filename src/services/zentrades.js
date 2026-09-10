/**
 * ZenTrades HTTP client.
 *
 * Deliberately NOT modeled on services/inspectpoint.js's `request(companyId,
 * method, path, options, credentials)` shape, where the caller resolves and
 * threads credentials through every call. ZenTrades' credential is a 24-hour
 * JWT with no refresh token (see migrations/107_zentrades_integration.sql's
 * header) — re-authentication has to happen transparently, mid-request, and
 * the result persisted back to the DB so the next cold serverless
 * invocation doesn't have to log in again. That statefulness belongs here,
 * not in every call site, so this module owns companyId -> token resolution
 * internally via db/zentrades-credentials.
 */

const config = require("../config");
const logger = require("../utils/logger");
const credentialsDb = require("../db/zentrades-credentials");
const todosDb = require("../db/todos");

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 2000;
// ZenTrades has NO refresh-token endpoint — login() is the only way to get a
// new access token, and it needs the plaintext password every time. The
// token's OWN `exp` claim says 24h even with rememberMe:true (verified
// against the documented sample), but the account's real session lifetime
// under rememberMe is 30 days — so we deliberately do NOT trust the token's
// exp claim for our refresh schedule (see login()'s ACCESS_TOKEN_TTL_MS use).
// Trusting the 24h claim would force a login call (and a stored-password
// decrypt) roughly 30x more often than necessary.
const ACCESS_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_SKEW_MS = 5 * 60 * 1000; // re-login 5min before expiry so a long sync can't straddle the boundary
const PER_PAGE = 200; // each hit embeds customer/serviceAddress/assignments — ~5KB/hit; 500 is a needless multi-MB response

// L1 cache in front of the DB-persisted token (zentrades_integration.access_token).
// This process is serverless (see vercel.json crons) — every cold invocation
// starts empty, so the DB copy is what actually saves most runs a login call,
// not this Map. Keyed by String(companyId).
const tokenCache = new Map();

// VERIFIED LIVE against a real captured request from ZenTrades' own web app:
// - the token goes on a bare `access-token` header (no "Bearer " prefix) —
//   `Authorization: Bearer <token>` alone gets a 401 "Access token missing".
// - `company-id` / `user-id` headers are ALSO required, redundant as that
//   is with the same two values already inside the JWT's own payload.
// `Authorization: Bearer` is kept alongside `access-token` at zero cost in
// case some other endpoint reads it instead.
//
// timezone-offset/timezonename are additionally required by the write path
// (api_doc/ztticket_update.md: "recommended... omit it and editRecurringEvent
// maths drifts") — sent on every request, not just writes, so a read and a
// subsequent write for the same company never disagree about which zone is
// in effect.
function buildAuthHeaders(accessToken, zentradesCompanyId, zentradesUserId, timezoneRegionName) {
  const headers = {
    "access-token": accessToken,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
  if (zentradesCompanyId != null) headers["company-id"] = String(zentradesCompanyId);
  if (zentradesUserId != null) headers["user-id"] = String(zentradesUserId);
  if (timezoneRegionName) {
    headers["timezonename"] = timezoneRegionName;
    const offsetMin = computeTimezoneOffsetMinutes(timezoneRegionName);
    if (offsetMin != null) headers["timezone-offset"] = String(offsetMin);
  }
  return headers;
}

/**
 * Minutes offset from UTC for an IANA zone, in the SAME sign convention as
 * `Date.prototype.getTimezoneOffset()` — negative for zones AHEAD of UTC
 * (e.g. Asia/Calcutta => -330). Verified against the real captured request in
 * api_doc/zentrades.md, which carries exactly `timezone-offset: -330` for an
 * Asia/Calcutta browser. Computed per-call (not cached) since the correct
 * value changes across a DST boundary for zones that observe it.
 */
function computeTimezoneOffsetMinutes(tz) {
  if (!tz) return null;
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName");
    const m = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(part?.value || "GMT");
    if (!m) return 0;
    // GMT+X means the zone is AHEAD of UTC; getTimezoneOffset()'s convention
    // is negative for "ahead" — hence the sign inversion.
    const sign = m[1] === "+" ? -1 : 1;
    return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
  } catch {
    return null;
  }
}

function buildBaseUrl() {
  if (config.zentrades.baseUrlOverride) return config.zentrades.baseUrlOverride;
  return config.zentrades.baseUrl;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode (NOT verify) a JWT payload. Safe here specifically because we just
 * received this token directly from our own login() call over TLS — this is
 * reading our own token's expiry claim, never authenticating an inbound
 * request, so signature verification would add nothing.
 */
function decodeJwtPayload(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("malformed access token (not a JWT)");
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(json);
}

/**
 * POST /api/auth/login. A pure function of (username, password) — no
 * companyId, no DB access — so it serves both the connect-route's
 * verify-before-save flow and the internal re-auth-on-expiry flow with the
 * same code path.
 *
 * rememberMe is ALWAYS true per product decision — there is no refresh-token
 * endpoint, so this is the only lever available for keeping a connection
 * alive without asking the user to re-enter their password. We track OUR
 * OWN 30-day expiry window from the moment of issuance (ACCESS_TOKEN_TTL_MS)
 * rather than the token's own `exp` claim, which says a much shorter 24h
 * even with rememberMe:true — trusting that claim would force a login call
 * roughly 30x more often than the account can actually tolerate.
 *
 * @returns {Promise<
 *   {ok: true, accessToken: string, expiresAt: Date, zentradesCompanyId: number|null, zentradesUserId: number|null, timezoneRegionName: string|null} |
 *   {ok: false, status: number, reason: "invalid_credentials"|"error", message: string}
 * >}
 */
async function login(username, password) {
  const url = `${buildBaseUrl()}/api/auth/login`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, rememberMe: true }),
    });
  } catch (err) {
    logger.error("zentrades login: network error", { error: err.message });
    return { ok: false, status: 0, reason: "error", message: err.message };
  }

  const body = await response.json().catch(() => null);

  // 401/403 on the LOGIN endpoint itself is a credentials problem by
  // definition — there is no token yet to be forbidden with. (A 403 on a
  // later DATA call is a different case — a valid token whose role lacks
  // access to that module — handled separately in request() below, and
  // never routed through this function.)
  if (response.status === 401 || response.status === 403) {
    const message = body?.message || body?.error || `login failed with status ${response.status}`;
    return { ok: false, status: response.status, reason: "invalid_credentials", message };
  }
  if (!response.ok || body?.status !== "success" || !body?.result?.["access-token"]) {
    const message = body?.message || `unexpected login response (status ${response.status})`;
    logger.error("zentrades login: unexpected response shape", { status: response.status, message });
    return { ok: false, status: response.status, reason: "error", message };
  }

  const accessToken = body.result["access-token"];
  // Decoded only for the companyId/userId fallback below (when the response
  // body's own `user` object is missing them) — NOT for expiry anymore. A
  // decode failure is therefore non-fatal: the token still works fine as an
  // opaque bearer credential even if it doesn't parse as a three-part JWT.
  let payload = null;
  try {
    payload = decodeJwtPayload(accessToken);
  } catch (err) {
    logger.warn("zentrades login: access token did not decode as a JWT — proceeding anyway, its own claims are only a fallback", { error: err.message });
  }

  return {
    ok: true,
    accessToken,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_TTL_MS),
    zentradesCompanyId: body.result.user?.company?.id ?? payload?.companyId ?? null,
    zentradesUserId: body.result.user?.id ?? payload?.userId ?? null,
    timezoneRegionName: body.result.user?.company?.timezoneRegionName ?? null,
  };
}

/**
 * Verify a username/password work, before saving them — used by the connect
 * route. A real login, not a cheap ping (ZenTrades has no separate
 * ping/whoami endpoint documented).
 */
async function verifyCredentials(username, password) {
  const result = await login(username, password);
  if (!result.ok) return { ok: false, message: result.message };
  return {
    ok: true,
    accessToken: result.accessToken,
    expiresAt: result.expiresAt,
    metadata: {
      zentradesCompanyId: result.zentradesCompanyId,
      zentradesUserId: result.zentradesUserId,
      timezoneRegionName: result.timezoneRegionName,
    },
  };
}

/**
 * Force a fresh login for a company and persist the result. Called both by
 * getAccessToken (proactive refresh near expiry) and by request() (reactive
 * refresh on an unexpected 401 from a data call).
 *
 * @returns {Promise<string|null>} the new access token, or null if login
 *   failed (in which case auth_status/todo bookkeeping has already happened)
 */
async function refreshAccessToken(companyId) {
  const cacheKey = String(companyId);
  const creds = await credentialsDb.getCredentialsForLogin(companyId);
  if (!creds) return null;

  const result = await login(creds.username, creds.password);
  if (!result.ok) {
    tokenCache.delete(cacheKey);
    if (result.reason === "invalid_credentials") {
      logger.warn("zentrades: login failed — marking invalid_credentials", { companyId, status: result.status });
      await credentialsDb.markAuthFailed(companyId, "invalid_credentials", result.message);
      await todosDb
        .createCrmReauthTodo({ companyId, source: "zentrades", reason: "invalid_credentials", error: result.message })
        .catch((err) => logger.warn("zentrades: failed to raise reauth todo", { error: err.message, companyId }));
    } else {
      // A transport/shape error, not a credentials problem — don't mark
      // auth_status or file a reauth todo for what might be a transient
      // ZenTrades-side issue. Just fail this attempt.
      logger.error("zentrades: login errored (not a credentials issue)", { companyId, error: result.message });
    }
    return null;
  }

  await credentialsDb.setAccessToken(companyId, result.accessToken, result.expiresAt);
  tokenCache.set(cacheKey, {
    accessToken: result.accessToken, expiresAt: result.expiresAt,
    zentradesCompanyId: result.zentradesCompanyId, zentradesUserId: result.zentradesUserId,
    timezoneRegionName: result.timezoneRegionName,
  });
  return result.accessToken;
}

/**
 * Resolve a usable access token for a company: L1 cache -> DB-cached token
 * (both only if not within TOKEN_SKEW_MS of expiry) -> a fresh login.
 *
 * Returns null (never throws) when the integration isn't connected, or when
 * auth_status is not 'ok' — see markAuthFailed's doc: while locked out, we
 * deliberately skip attempting login at all rather than retrying a
 * known-bad password every call, which risks the ZenTrades account itself
 * getting rate-limited or locked, turning a two-minute fix into a support
 * call. Recovery happens only via the connect route saving new credentials
 * (db/zentrades-credentials.js's upsert resets auth_status to 'ok').
 */
async function getAccessToken(companyId) {
  const cacheKey = String(companyId);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt.getTime() - Date.now() > TOKEN_SKEW_MS) {
    return cached.accessToken;
  }

  const stored = await credentialsDb.getByCompanyId(companyId);
  if (!stored) return null;
  if (stored.authStatus !== "ok") return null;

  if (stored.accessToken && stored.accessTokenExpiresAt) {
    const expiresAt = new Date(stored.accessTokenExpiresAt);
    if (expiresAt.getTime() - Date.now() > TOKEN_SKEW_MS) {
      tokenCache.set(cacheKey, {
        accessToken: stored.accessToken, expiresAt,
        zentradesCompanyId: stored.metadata?.zentradesCompanyId ?? null,
        zentradesUserId: stored.metadata?.zentradesUserId ?? null,
        timezoneRegionName: stored.metadata?.timezoneRegionName ?? null,
      });
      return stored.accessToken;
    }
  }

  return refreshAccessToken(companyId);
}

/**
 * The company-id/user-id to send alongside a token — see buildAuthHeaders.
 * Only ever called right after getAccessToken() resolves to a non-null
 * token, at which point every code path that could have produced that token
 * has ALREADY populated this exact cache entry (see getAccessToken and
 * refreshAccessToken) — so this never needs its own DB read.
 */
function getCachedIdentity(companyId) {
  return tokenCache.get(String(companyId)) || {};
}

/**
 * One authenticated request. Returns `{ok, status, data, messages}` — the
 * same shape as services/inspectpoint.js's and services/servicetrade.js's
 * request(), so provider code treats all three CRMs uniformly.
 *
 * @param {string|number} companyId
 * @param {string} method
 * @param {string} path — e.g. "/api/ticket/search/filtered"
 * @param {{query?: object, body?: object, retryable?: boolean, suppressErrorTodo?: boolean}} [options] —
 *   `retryable` gates whether a 429/5xx/network failure is retried at all.
 *   Defaults to true for GET, false for POST — a POST here is usually a
 *   search-as-POST (safe to retry, pass retryable:true explicitly) but a
 *   mutating write-back POST/PUT retried blind could double-apply, so that
 *   class of call must NEVER override this default.
 *   `suppressErrorTodo` skips the generic api-error todo (createCrmApiErrorTodo)
 *   on failure — for write-back mirrors, which raise their own richer todo
 *   naming the specific action/entity; without this, Action Items would show
 *   two rows for one failed mirror. Never suppresses the 401/403
 *   auth-specific todos, which are about the CONNECTION, not one call.
 */
async function request(companyId, method, path, options = {}) {
  const { query = {}, body = null, retryable = method === "GET", suppressErrorTodo = false } = options;

  const url = new URL(`${buildBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`);
  // VERIFIED LIVE: a real captured request carries `timestamp=<unix ms>` on
  // every data call. Unknown whether it's enforced or just a cache-buster
  // the web app always sends — added unconditionally since matching a known
  // working request costs nothing. Fixed once per logical request (outside
  // the retry loop below), not recomputed per retry attempt.
  const queryWithTimestamp = { timestamp: Date.now(), ...query };
  for (const [key, value] of Object.entries(queryWithTimestamp)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      // Generic support for a repeatable query param (append, not set —
      // set collapses to the last value). Nothing currently sends an array
      // here; kept for whatever the next query param that needs it is.
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  const requestBody = body != null ? JSON.stringify(body) : undefined;

  let triedRefreshOn401 = false;

  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    const token = await getAccessToken(companyId);
    if (!token) {
      return { ok: false, status: 401, data: null, messages: { error: ["ZenTrades not authenticated"] } };
    }

    const identity = getCachedIdentity(companyId);
    let response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers: buildAuthHeaders(token, identity.zentradesCompanyId, identity.zentradesUserId, identity.timezoneRegionName),
        body: requestBody,
      });
    } catch (err) {
      if (attempt < RETRY_ATTEMPTS && retryable) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      logger.error("zentrades: request failed (network)", { companyId, method, path, error: err.message });
      if (!suppressErrorTodo) {
        await todosDb
          .createCrmApiErrorTodo({ companyId, source: "zentrades", method, path, status: 0, error: err.message })
          .catch((e) => logger.warn("zentrades: failed to raise api-error todo", { error: e.message, companyId }));
      }
      return { ok: false, status: 0, data: null, messages: { error: [err.message] } };
    }

    // A 401 on a DATA call (as opposed to login()) means our cached token
    // expired earlier than its own exp claim suggested (clock skew, or the
    // server invalidated it early) — force exactly one fresh login and
    // replay, never loop. If the fresh login itself fails, refreshAccessToken
    // has already done the auth_status/todo bookkeeping.
    if (response.status === 401 && !triedRefreshOn401) {
      triedRefreshOn401 = true;
      tokenCache.delete(String(companyId));
      const fresh = await refreshAccessToken(companyId);
      if (!fresh) {
        return { ok: false, status: 401, data: null, messages: { error: ["ZenTrades re-authentication failed"] } };
      }
      // `continue` in a for-loop still runs the increment — decrement first
      // so this auth-correction retry doesn't eat into the RETRY_ATTEMPTS
      // budget that 429/5xx handling below relies on.
      attempt--;
      continue;
    }

    // A 403 with a token we just successfully used to log in is NOT a
    // credentials problem — it's this ZenTrades user's role lacking access
    // to this specific module/endpoint. Re-entering a password would not
    // fix it, so this is tracked as a distinct 'forbidden' status with its
    // own todo naming the endpoint, never routed through markAuthFailed's
    // 'invalid_credentials' path.
    if (response.status === 403) {
      const errBody = await response.json().catch(() => null);
      const message = errBody?.message || `forbidden on ${method} ${path}`;
      logger.error("zentrades: 403 on data call — role lacks access", { companyId, method, path, message });
      await credentialsDb.markAuthFailed(companyId, "forbidden", message).catch(() => {});
      await todosDb
        .createCrmReauthTodo({ companyId, source: "zentrades", reason: "forbidden", error: `${method} ${path}: ${message}` })
        .catch((err) => logger.warn("zentrades: failed to raise forbidden todo", { error: err.message, companyId }));
      return { ok: false, status: 403, data: null, messages: { error: [message] } };
    }

    if (response.status === 429 && attempt < RETRY_ATTEMPTS && retryable) {
      const retryAfterSec = Number(response.headers.get("retry-after")) || RETRY_BASE_MS / 1000;
      await sleep(retryAfterSec * 1000);
      continue;
    }
    if (response.status >= 500 && attempt < RETRY_ATTEMPTS && retryable) {
      await sleep(RETRY_BASE_MS * 2 ** attempt);
      continue;
    }

    const respBody = await response.json().catch(() => null);
    // The list endpoint returns a bare {requestId, count, hits} envelope;
    // the detail endpoint wraps in {status, result}. Unwrap defensively —
    // there is no single shape to assume, same reasoning as
    // services/inspectpoint.js's per-endpoint `extract` callback.
    const data = respBody?.result !== undefined ? respBody.result : respBody;
    const messages = respBody?.message ? { error: [respBody.message] } : {};

    // Any OTHER non-2xx (400/404/409/429-or-5xx-after-retries-exhausted) —
    // 401 and 403 are handled above with their own more specific todos, so
    // this is everything else. Deliberately generic per product decision:
    // any ZenTrades API error should be visible in Action Items, not just
    // discoverable via zentrades_sync_state.last_sync_error on a status page
    // someone has to think to check.
    if (!response.ok) {
      const message = respBody?.message || `HTTP ${response.status}`;
      logger.error("zentrades: request failed", { companyId, method, path, status: response.status, message });
      if (!suppressErrorTodo) {
        await todosDb
          .createCrmApiErrorTodo({ companyId, source: "zentrades", method, path, status: response.status, error: message })
          .catch((e) => logger.warn("zentrades: failed to raise api-error todo", { error: e.message, companyId }));
      }
    }

    return { ok: response.ok, status: response.status, data, messages, envelope: respBody };
  }

  return { ok: false, status: 0, data: null, messages: { error: ["exhausted retries"] } };
}

/**
 * Page through the ticket search to exhaustion for one (body, dateWindow)
 * combination. Unlike services/inspectpoint.js's fetchAllPages, the filter
 * is a POST BODY (constant across pages) with pagination carried in the
 * QUERY string — neither existing client does both at once.
 *
 * Terminates on an EMPTY page, never on `hits.length < size` — the doc
 * documents size up to 500 but says nothing about server-side clamping;
 * see services/inspectpoint.js:110-116 for why that termination condition
 * is unsafe against an undocumented API. `page` is 1-based (per the doc's
 * own example URL), unlike InspectPoint's 0-based `offset`.
 *
 * No `sortBy` param — VERIFIED LIVE: the API rejects it outright with a
 * validation error (`"sortBy" is not allowed`, code E100), it doesn't just
 * silently ignore it. Pagination stability therefore relies entirely on
 * services/zentrades-sync.js's window-slicing + count-reconciliation, not on
 * a stable sort order — exactly the fallback that design was already built
 * to not depend on this working.
 *
 * @param {string|number} companyId
 * @param {string} path — e.g. "/api/ticket/search/filtered"
 * @param {object} requestBody — the filter body, sent unchanged on every page
 * @param {{pageSize?: number, retryable?: boolean}} [opts]
 * @returns {Promise<{rows: any[], complete: boolean, count: number|null}>}
 */
async function fetchAllPages(companyId, path, requestBody, { pageSize = PER_PAGE, retryable = true, maxPages = 200 } = {}) {
  const rows = [];
  let count = null;
  for (let page = 1; page <= maxPages; page++) {
    const query = { page, size: pageSize };

    const result = await request(companyId, "POST", path, { query, body: requestBody, retryable });

    if (!result.ok) {
      logger.warn("zentrades: fetchAllPages page failed", { companyId, path, page, status: result.status });
      return { rows, complete: false, count };
    }

    // Bare envelope on the list endpoint: {requestId, count, hits}. request()
    // only unwraps the {status,result} shape, so `data` here IS the envelope.
    const envelope = result.data || {};
    if (page === 1) count = typeof envelope.count === "number" ? envelope.count : null;
    const hits = Array.isArray(envelope.hits) ? envelope.hits : [];

    // A zero-match search returns a DIFFERENT envelope shape on this endpoint
    // — {results: [], total: 0} instead of {requestId, count, hits} — verified
    // live 2026-09-10 (company 13/zentradesCompanyId 974). Harmless for the
    // zero-hits case itself (falls through to the same "empty page" return
    // below either way), but logged explicitly since an envelope shape this
    // API can silently change on is exactly the kind of thing worth having a
    // trail for the next time something here looks empty that shouldn't be.
    if (!("hits" in envelope) && Object.keys(envelope).length > 0) {
      logger.warn("zentrades: fetchAllPages got an unexpected envelope shape (no 'hits' key)", {
        companyId, path, page, envelopeKeys: Object.keys(envelope),
      });
    }
    logger.debug("zentrades: fetchAllPages page result", {
      companyId, path, page, hits: hits.length, envelopeCount: envelope.count ?? envelope.total ?? null,
    });

    if (hits.length === 0) return { rows, complete: true, count };
    rows.push(...hits);
  }
  logger.warn("zentrades: fetchAllPages hit maxPages — server may be ignoring page", { companyId, path, maxPages });
  return { rows, complete: false, count };
}

module.exports = {
  login,
  verifyCredentials,
  getAccessToken,
  request,
  fetchAllPages,
  buildBaseUrl,
  decodeJwtPayload,
};
