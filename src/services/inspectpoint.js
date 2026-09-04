/**
 * InspectPoint HTTP client.
 *
 * Deliberately NOT modeled on services/servicetrade.js: ServiceTrade auth is a
 * login-and-cookie session that needs caching/refresh; InspectPoint auth is a
 * static per-tenant `Api-Key` header against `https://{subdomain}.inspectpoint.com`
 * — there is no session to establish, so there is no login(), no token cache,
 * no re-auth-on-401 retry. Every request either has a working key or doesn't.
 */

const config = require("../config");
const logger = require("../utils/logger");

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS = 2000;
const PER_PAGE = 100; // real behavior: the server silently clamps `max` to this, undocumented

function buildBaseUrl(subdomain) {
  // Local-dev-only escape hatch — see config/index.js's comment. Real
  // InspectPoint has no equivalent; this is never set outside development.
  if (config.inspectpoint.baseUrlOverride) return config.inspectpoint.baseUrlOverride;
  return `https://${subdomain}.inspectpoint.com`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One authenticated request. Returns `{ ok, status, data, messages }` — same
 * shape as services/servicetrade.js's request() so provider code can treat
 * both CRMs uniformly, minus the `cookie` field ServiceTrade needs and this
 * doesn't.
 *
 * @param {string|number} companyId — for logging only; the request itself is
 *   fully identified by `credentials`.
 * @param {string} method
 * @param {string} path — e.g. "/external/api/v1/accounts"
 * @param {{query?: object, body?: object}} [options]
 * @param {{subdomain: string, authCode: string}} credentials
 */
async function request(companyId, method, path, options = {}, credentials = null) {
  if (!credentials?.subdomain || !credentials?.authCode) {
    return { ok: false, status: 401, data: null, messages: { error: ["InspectPoint not authenticated"] } };
  }

  const base = buildBaseUrl(credentials.subdomain);
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const requestBody = options.body != null ? JSON.stringify(options.body) : undefined;

  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(url.toString(), {
        method,
        headers: {
          "Api-Key": credentials.authCode,
          "Content-Type": "application/json",
        },
        body: requestBody,
      });
    } catch (err) {
      if (attempt < RETRY_ATTEMPTS) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      logger.error("inspectpoint: request failed (network)", { companyId, method, path, error: err.message });
      return { ok: false, status: 0, data: null, messages: { error: [err.message] } };
    }

    // 429 must honour Retry-After (seconds) — InspectPoint documents this
    // explicitly, unlike ServiceTrade, which gets blind exponential backoff.
    if (response.status === 429 && attempt < RETRY_ATTEMPTS) {
      const retryAfterSec = Number(response.headers.get("retry-after")) || RETRY_BASE_MS / 1000;
      await sleep(retryAfterSec * 1000);
      continue;
    }
    if (response.status >= 500 && attempt < RETRY_ATTEMPTS) {
      await sleep(RETRY_BASE_MS * 2 ** attempt);
      continue;
    }

    const body = await response.json().catch(() => null);
    const data = body?.data !== undefined ? body.data : body;
    const messages = body?.errors ? { error: body.errors.map((e) => e?.title || String(e)) } : {};
    return { ok: response.ok, status: response.status, data, messages };
  }

  // Unreachable — the loop always returns before falling through.
  return { ok: false, status: 0, data: null, messages: { error: ["exhausted retries"] } };
}

/**
 * Verify a subdomain + API key actually work, before saving them — the
 * cheapest possible read. There is no dedicated auth/ping endpoint, so this
 * asks for exactly one account.
 */
async function verifyCredentials(subdomain, authCode) {
  const result = await request(null, "GET", "/external/api/v1/accounts", { query: { max: 1 } }, { subdomain, authCode });
  return result.ok;
}

/**
 * Page through a list endpoint to exhaustion.
 *
 * Terminates on an EMPTY page, never on `returned.length < max` — the API
 * documents `max` (default 50) but not a cap, and in practice silently clamps
 * to 100. A `< max` termination would stop after page one against a server
 * that clamps a larger request, reporting success on a sync that only ever
 * covered the first page. `maxPages` is a hard backstop against a server that
 * ignores `offset` entirely and would otherwise loop forever.
 *
 * @param {string|number} companyId
 * @param {string} path
 * @param {object} params — static query params (filters); `max`/`offset` are added here
 * @param {{subdomain: string, authCode: string}} credentials
 * @param {(body: any) => any[]} extract — pulls the row array out of whatever
 *   envelope this endpoint uses. Required because envelopes differ per
 *   endpoint (`{accounts:[...]}`, a bare array, or the double-wrapped
 *   `{inspections:[{inspection:{...}}]}`) — unlike ServiceTrade's uniform
 *   `{data:[...], totalPages}, there is no single shape to assume.
 * @returns {Promise<{rows: any[], complete: boolean}>}
 */
async function fetchAllPages(companyId, path, params, credentials, extract, { maxPages = 200 } = {}) {
  const rows = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const result = await request(companyId, "GET", path, { query: { ...params, max: PER_PAGE, offset } }, credentials);
    if (!result.ok) {
      logger.warn("inspectpoint: fetchAllPages page failed", { companyId, path, offset, status: result.status });
      return { rows, complete: false };
    }
    let batch;
    try {
      batch = extract(result.data) || [];
    } catch (err) {
      logger.error("inspectpoint: fetchAllPages extractor threw", { companyId, path, offset, error: err.message });
      return { rows, complete: false };
    }
    if (!Array.isArray(batch)) {
      logger.error("inspectpoint: fetchAllPages extractor returned a non-array", { companyId, path, offset });
      return { rows, complete: false };
    }
    if (batch.length === 0) return { rows, complete: true };
    rows.push(...batch);
    offset += batch.length;
  }
  logger.warn("inspectpoint: fetchAllPages hit maxPages — server may be ignoring offset", { companyId, path, maxPages });
  return { rows, complete: false };
}

module.exports = { request, verifyCredentials, fetchAllPages, buildBaseUrl };
