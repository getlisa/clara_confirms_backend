/**
 * ServiceTrade API client (per-company)
 *
 * Auth pattern: POST /auth returns a `Set-Cookie: PHPSESSID=…` header. We
 * extract just the `PHPSESSID=value` name/value pair (no flags) and use it
 * directly as the `Cookie:` request header on every subsequent call. The
 * cookie persists until ServiceTrade invalidates the session, so we only
 * re-auth on 401/404 from a downstream call — never on a fixed timer.
 *
 * `auth_code` column in `servicetrade_integration` stores this full pair
 * (e.g. "PHPSESSID=abc123"). The column name is unchanged for backwards
 * compatibility; legacy rows that contain just the bare token are
 * normalized to the new format via `toCookiePair()` before use.
 *
 * @see api.servicetrade.com API docs - Authentication resource
 */

const config = require("../config");
const logger = require("../utils/logger");

const BASE = config.servicetrade.baseUrl;

// Per-company cookie cache: companyId -> { cookie: "PHPSESSID=xxx" }
const tokenCache = new Map();

/**
 * Extract the PHPSESSID name/value pair from a Set-Cookie header.
 * Returns the literal string to use as `Cookie: …` on subsequent requests.
 * Strips path/secure/expires flags — keeps only `PHPSESSID=xxx`.
 */
function extractCookieFromResponse(res) {
  // Standard fetch Response: getSetCookie() returns string[] of all Set-Cookie headers
  const cookies = typeof res.headers.getSetCookie === "function"
    ? res.headers.getSetCookie()
    : (res.headers.raw?.()["set-cookie"] || (res.headers.get?.("set-cookie") ? [res.headers.get("set-cookie")] : []));
  for (const c of cookies) {
    const m = String(c).match(/PHPSESSID=([^;]+)/i);
    if (m) return `PHPSESSID=${m[1]}`;
  }
  return null;
}

/**
 * Normalize a stored auth_code into a Cookie header value.
 * Accepts both new format ("PHPSESSID=xxx") and legacy bare tokens.
 */
function toCookiePair(stored) {
  if (!stored) return null;
  const s = String(stored).trim();
  if (s.startsWith("PHPSESSID=")) return s;
  return `PHPSESSID=${s}`;
}

function buildFetchError(error, details) {
  const wrapped = new Error(error && error.message ? error.message : "ServiceTrade fetch failed");
  wrapped.name = "ServiceTradeFetchError";
  wrapped.code = error && error.code ? error.code : undefined;
  wrapped.cause = error;
  wrapped.details = details;
  return wrapped;
}

async function performFetch(url, requestOptions, details) {
  try {
    return await fetch(url, requestOptions);
  } catch (error) {
    throw buildFetchError(error, details);
  }
}

/**
 * Login with username and password.
 *
 * Stores the full PHPSESSID cookie pair in the in-memory cache and returns
 * it so the caller can persist it to `servicetrade_integration.auth_code`.
 *
 * @param {string|number} companyId
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ cookie: string, authToken: string, user: object }|null>}
 *          `cookie` is the literal Cookie header value (e.g. "PHPSESSID=abc").
 *          `authToken` is the bare token from the JSON body (legacy field, kept for compat).
 */
async function login(companyId, username, password) {
  if (!username || !password) {
    logger.warn("ServiceTrade login: username and password required");
    return null;
  }

  const url = `${BASE}/auth`;
  const res = await performFetch(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    },
    { companyId, method: "POST", path: "/auth" }
  );

  const body = await res.json().catch(() => ({}));
  const data = body.data || body;

  if (res.status === 200 && data.authenticated && data.authToken) {
    // Prefer the Set-Cookie header value; fall back to building it from authToken
    console.log("Cookie from header", extractCookieFromResponse(res));
    const cookieFromHeader = extractCookieFromResponse(res);
    const cookie = cookieFromHeader || `PHPSESSID=${data.authToken}`;
    tokenCache.set(String(companyId), { cookie });
    logger.info("ServiceTrade login success", {
      companyId,
      username: username.replace(/.(?=.@)/g, "*"),
      cookieSource: cookieFromHeader ? "set-cookie-header" : "authToken-fallback",
    });
    return { cookie, authToken: data.authToken, user: data.user };
  }

  if (res.status === 403) {
    logger.warn("ServiceTrade login failed: invalid credentials");
    return null;
  }

  if (res.status === 400) {
    logger.warn("ServiceTrade login failed: username and/or password not given");
    return null;
  }

  logger.warn("ServiceTrade login failed", { status: res.status, messages: body.messages });
  return null;
}

/**
 * Validate the cached/provided cookie by calling GET /auth.
 * @param {string|number} companyId
 * @param {string} [cookie] - Cookie header value; falls back to cache
 * @returns {Promise<{ authenticated: boolean, cookie: string, user: object }|null>}
 */
async function getSession(companyId, cookie) {
  const cached = tokenCache.get(String(companyId));
  const cookiePair = toCookiePair(cookie || (cached && cached.cookie));
  if (!cookiePair) return null;

  const url = `${BASE}/auth`;
  const res = await performFetch(
    url,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair,
      },
    },
    { companyId, method: "GET", path: "/auth" }
  );

  const body = await res.json().catch(() => ({}));
  const data = body.data || body;

  if (res.status === 200 && data.authenticated) {
    return { authenticated: true, cookie: cookiePair, user: data.user };
  }

  if (res.status === 404) {
    tokenCache.delete(String(companyId));
    return null;
  }

  return null;
}

/**
 * Ensure we have a valid session for the company; if not, login with provided credentials.
 * @param {string|number} companyId
 * @param {{ username: string, password: string }|null} credentials
 * @returns {Promise<string|null>} - cookie pair string or null
 */
async function ensureSession(companyId, credentials) {
  const session = await getSession(companyId);
  if (session) return session.cookie;

  if (!credentials || !credentials.username || !credentials.password) return null;

  const result = await login(companyId, credentials.username, credentials.password);
  return result ? result.cookie : null;
}

/**
 * Make an authenticated request to the ServiceTrade API for a company.
 * @param {string|number} companyId
 * @param {string} method - GET, POST, PUT, DELETE
 * @param {string} path - e.g. "/company/123"
 * @param {object} [options] - { body } for JSON body
 * @param {{ username?: string, password?: string, authCode?: string }|null} [credentials] - DB creds { username, authCode } or login { username, password } for retry
 * @returns {Promise<{ ok: boolean, status: number, data?: object, messages?: object }>}
 */
async function request(companyId, method, path, options = {}, credentials = null) {
  let cookie = null;
  if (credentials && credentials.authCode) {
    cookie = toCookiePair(credentials.authCode);
    tokenCache.set(String(companyId), { cookie });
  }
  if (!cookie) {
    cookie = await ensureSession(companyId, credentials);
  }
  if (!cookie) {
    return { ok: false, status: 401, data: null, messages: { error: ["ServiceTrade not authenticated"] } };
  }

  const url = path.startsWith("http") ? path : `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    "Content-Type": "application/json",
    Cookie: cookie,
    ...options.headers,
  };

  const requestBody =
    options.body != null ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined;

  let res = await performFetch(
    url,
    {
      method,
      headers,
      body: requestBody,
    },
    { companyId, method, path, hasBody: requestBody != null }
  );

  if ((res.status === 401 || res.status === 404) && credentials) {
    tokenCache.delete(String(companyId));
    cookie = await ensureSession(companyId, credentials);
    if (cookie) {
      headers.Cookie = cookie;
      res = await performFetch(
        url,
        {
          method,
          headers,
          body: requestBody,
        },
        { companyId, method, path, hasBody: requestBody != null, retriedAfterAuthRefresh: true }
      );
    }
  }

  const body = await res.json().catch(() => ({}));
  const data = body.data !== undefined ? body.data : body;
  const messages = body.messages || {};

  return {
    ok: res.ok,
    status: res.status,
    data,
    messages,
    cookie, // expose for callers that want to persist a refreshed cookie
  };
}

/**
 * Logout (close session) for a company.
 * @param {string|number} companyId
 * @param {string} [token] - If not provided, uses cached token for company
 */
async function logout(companyId, cookieOrToken) {
  const cached = tokenCache.get(String(companyId));
  const cookie = toCookiePair(cookieOrToken || (cached && cached.cookie));
  if (!cookie) return;

  const url = `${BASE}/auth`;
  await performFetch(
    url,
    {
      method: "DELETE",
      headers: { Cookie: cookie },
    },
    { companyId, method: "DELETE", path: "/auth" }
  );
  tokenCache.delete(String(companyId));
  logger.info("ServiceTrade session closed", { companyId });
}

module.exports = {
  login,
  getSession,
  ensureSession,
  request,
  logout,
};
