const config = require("../config");
const logger = require("../utils/logger");

const BASE = config.servicetrade.baseUrl;

// Per-company cookie cache: companyId -> { cookie: "PHPSESSID=xxx" }
const tokenCache = new Map();

// Extract the PHPSESSID name/value pair from a Set-Cookie header.
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

// Normalize a stored auth_code into a Cookie header value.
function toCookiePair(stored) {
  if (!stored) return null;
  const s = String(stored).trim();
  if (s.startsWith("PHPSESSID=")) return s;
  return `PHPSESSID=${s}`;
}

// Wrap a network-level failure (DNS, refused, timeout) with request context so
// callers log something actionable instead of a bare "fetch failed".
function buildFetchError(error, context = {}) {
  const err = new Error(`ServiceTrade request failed (${context.method || "?"} ${context.path || "?"}): ${error?.message || error}`);
  err.cause = error;
  err.context = context;
  err.isNetworkError = true;
  return err;
}

// One login attempt. Returns { result, status } so the automatic re-login can
// tell "ServiceTrade rejected these credentials" (status 403 — a human must
// reconnect) from a transient failure (5xx — just try again later).
async function attemptLogin(companyId, username, password) {
  if (!username || !password) {
    logger.warn("ServiceTrade login: username and password required");
    return { result: null, status: 400 };
  }

  const url = `${BASE}/auth`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
  } catch (error) {
    throw buildFetchError(error, { companyId, method: "POST", path: "/auth" });
  }
  const body = await response.json().catch(() => ({}));
  const data = body.data || body;

  if (response.status === 200 && data.authenticated && data.authToken) {
    // Prefer the Set-Cookie header value; fall back to building it from authToken.
    // Never log the cookie itself — it is a live credential.
    const cookieFromHeader = extractCookieFromResponse(response);
    const cookie = cookieFromHeader || `PHPSESSID=${data.authToken}`;
    tokenCache.set(String(companyId), { cookie });
    logger.info("ServiceTrade login success", {
      companyId,
      username: username.replace(/.(?=.@)/g, "*"),
      cookieSource: cookieFromHeader ? "set-cookie-header" : "authToken-fallback",
    });
    return { result: { cookie, authToken: data.authToken, user: data.user }, status: 200 };
  }

  if (response.status === 403) logger.warn("ServiceTrade login failed: invalid credentials", { companyId });
  else if (response.status === 400) logger.warn("ServiceTrade login failed: username and/or password not given", { companyId });
  else logger.warn("ServiceTrade login failed", { companyId, status: response.status, messages: body.messages });
  return { result: null, status: response.status };
}

// Login with username and password.
async function login(companyId, username, password) {
  return (await attemptLogin(companyId, username, password)).result;
}

// Validate the cached/provided cookie by calling GET /auth.
async function getSession(companyId, cookie) {
  const cached = tokenCache.get(String(companyId));
  const cookiePair = toCookiePair(cookie || (cached && cached.cookie));
  if (!cookiePair) return null;

  const url = `${BASE}/auth`;
  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json", Cookie: cookiePair },
    });
  } catch (error) {
    throw buildFetchError(error, { companyId, method: "GET", path: "/auth" });
  }
  const body = await response.json().catch(() => ({}));
  const data = body.data || body;

  if (response.status === 200 && data.authenticated) {
    return { authenticated: true, cookie: cookiePair, user: data.user };
  }

  if (response.status === 404 || response.status === 401) {
    tokenCache.delete(String(companyId));
    return null;
  }

  logger.warn("ServiceTrade session validation failed", { status: response.status, messages: body.messages });
  return null;
}

// Ensure we have a valid session for the company; if not, login with provided credentials.
async function ensureSession(companyId, credentials) {
  const session = await getSession(companyId);
  if (session) return session.cookie;

  if (!credentials || !credentials.username || !credentials.password) return null;

  const result = await login(companyId, credentials.username, credentials.password);
  return result ? result.cookie : null;
}

// ── Automatic re-login ──────────────────────────────────────────────────────
//
// ServiceTrade ends PHPSESSID sessions on its own schedule (no documented
// lifetime; it also prunes a user's oldest sessions past 200 concurrent), so
// a stored session WILL die. With the password stored encrypted
// (db/servicetrade-credentials.js), we log in again ourselves and carry on —
// the connection never needs a human unless the password itself changed.

const reauthInFlight = new Map();

// Point every holder of the old session at the new one: the in-process cache
// and the caller's credentials object (a sync run reuses one object across
// hundreds of requests).
function adoptSession(companyId, cookie, credentials) {
  tokenCache.set(String(companyId), { cookie });
  if (credentials && typeof credentials === "object") credentials.authCode = cookie;
}

/**
 * Get a working session again after ServiceTrade rejected `staleCookie`.
 * At most one re-login per company at a time in this process; concurrent
 * callers share it. Returns the new cookie, or null when it cannot be renewed
 * (no stored password, or ServiceTrade rejected it — recorded as auth_error).
 * Never throws.
 */
async function reauthenticate(companyId, credentials = null, staleCookie = null) {
  const key = String(companyId);
  if (reauthInFlight.has(key)) return reauthInFlight.get(key);

  const attempt = (async () => {
    const credsDb = require("../db/servicetrade-credentials");
    try {
      // Another instance (serverless: many) may have renewed it already —
      // reuse that session instead of minting yet another one.
      const current = await credsDb.getByCompanyId(companyId);
      if (current?.authCode && staleCookie && toCookiePair(current.authCode) !== toCookiePair(staleCookie)) {
        if (await getSession(companyId, current.authCode)) {
          const cookie = toCookiePair(current.authCode);
          adoptSession(companyId, cookie, credentials);
          return cookie;
        }
      }

      const secret = await credsDb.getPasswordForReauth(companyId);
      if (!secret) {
        await credsDb.markAuthError(companyId, "ServiceTrade session expired and no password is stored to renew it. Reconnect ServiceTrade once to enable automatic renewal.");
        logger.warn("ServiceTrade re-login impossible: no stored password", { companyId });
        return null;
      }

      const { result, status } = await attemptLogin(companyId, secret.username, secret.password);
      if (!result) {
        // 400/403: ServiceTrade rejected the stored credentials — a human has
        // to reconnect. Anything else is transient; the next call retries.
        if (status === 400 || status === 403) {
          await credsDb.markAuthError(companyId, "ServiceTrade rejected the saved login (was the password changed?). Reconnect ServiceTrade.");
        }
        return null;
      }

      await credsDb.updateSession(companyId, result.cookie);
      adoptSession(companyId, result.cookie, credentials);
      logger.info("ServiceTrade session renewed automatically", { companyId });
      return result.cookie;
    } catch (err) {
      logger.warn("ServiceTrade re-login failed (transient)", { companyId, error: err.message });
      return null;
    }
  })().finally(() => reauthInFlight.delete(key));

  reauthInFlight.set(key, attempt);
  return attempt;
}

/**
 * Keep a company's session alive: validate it, renew it if ServiceTrade has
 * ended it. Run on a schedule so the session is already fresh when a sync,
 * webhook or live call needs it. GET /auth does not create a session, so
 * checking is free. Never throws.
 *
 * @returns {Promise<{status: "alive"|"renewed"|"failed"}>}
 */
async function keepAlive(companyId) {
  const credsDb = require("../db/servicetrade-credentials");
  try {
    const creds = await credsDb.getByCompanyId(companyId);
    if (creds?.authCode && (await getSession(companyId, creds.authCode))) return { status: "alive" };
    const fresh = await reauthenticate(companyId, creds, creds?.authCode || null);
    return { status: fresh ? "renewed" : "failed" };
  } catch (err) {
    logger.warn("ServiceTrade keep-alive check failed (transient)", { companyId, error: err.message });
    return { status: "failed" };
  }
}

// Make an authenticated request to the ServiceTrade API for a company.
// A 401 means ServiceTrade no longer accepts the session: renew it once
// (reauthenticate) and retry. A 404 is a missing resource, never a reason to
// log in again.
async function request(companyId, method, path, options = {}, credentials = null) {
  let cookie = null;
  if (credentials && credentials.authCode) {
    cookie = toCookiePair(credentials.authCode);
    tokenCache.set(String(companyId), { cookie });
  }
  if (!cookie) {
    cookie = await ensureSession(companyId, credentials);
  }
  if (!cookie && credentials) {
    cookie = await reauthenticate(companyId, credentials, null);
  }
  if (!cookie) {
    return { ok: false, status: 401, data: null, messages: { error: ["ServiceTrade not authenticated"] } };
  }

  const url = path.startsWith("http") ? path : `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const requestBody =
    options.body != null ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined;
  const send = (ck) => fetch(url, {
    method,
    headers: { "Content-Type": "application/json", ...options.headers, Cookie: ck },
    body: requestBody,
  });

  try {
    let response = await send(cookie);

    if (response.status === 401 && credentials) {
      const fresh = await reauthenticate(companyId, credentials, cookie);
      if (fresh) {
        cookie = fresh;
        response = await send(cookie);
      }
    }

    const body = await response.json().catch(() => ({}));
    const data = body.data !== undefined ? body.data : body;
    const messages = body.messages || {};

    return {
      ok: response.ok,
      status: response.status,
      data,
      messages,
      cookie, // expose for callers that want to persist a refreshed cookie
    };
  } catch (error) {
    throw buildFetchError(error, { companyId, method, path, hasBody: requestBody != null });
  }
}

// Logout (close session) for a company.
async function logout(companyId, cookieOrToken) {
  const cached = tokenCache.get(String(companyId));
  const cookie = toCookiePair(cookieOrToken || (cached && cached.cookie));
  if (!cookie) return;

  const url = `${BASE}/auth`;
  await fetch(url, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  tokenCache.delete(String(companyId));
  logger.info("ServiceTrade session closed", { companyId });
}

module.exports = {
  login,
  getSession,
  ensureSession,
  reauthenticate,
  keepAlive,
  request,
  logout,
};
