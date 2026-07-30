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

// Login with username and password.
async function login(companyId, username, password) {
  if (!username || !password) {
    logger.warn("ServiceTrade login: username and password required");
    return null;
  }

  const url = `${BASE}/auth`;
  try{
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const body = await response.json().catch(() => ({}));
    const data = body.data || body;

    if (response.status === 200 && data.authenticated && data.authToken) {
      // Prefer the Set-Cookie header value; fall back to building it from authToken
      const cookieFromHeader = extractCookieFromResponse(response);
      console.log("cookieFromHeader", cookieFromHeader);
      const cookie = cookieFromHeader || `PHPSESSID=${data.authToken}`;
      tokenCache.set(String(companyId), { cookie });
      logger.info("ServiceTrade login success", {
        companyId,
        username: username.replace(/.(?=.@)/g, "*"),
        cookieSource: cookieFromHeader ? "set-cookie-header" : "authToken-fallback",
      });
      return { cookie, authToken: data.authToken, user: data.user };
    }

    if (response.status === 403) {
      logger.warn("ServiceTrade login failed: invalid credentials");
      return null;
    }

    if (response.status === 400) {
      logger.warn("ServiceTrade login failed: username and/or password not given");
      return null;
    }

    logger.warn("ServiceTrade login failed", { status: response.status, messages: body.messages });
    return null;
  }
   catch (error) {
    throw buildFetchError(error, { companyId, method: "POST", path: "/auth" });
  } 
}

// Validate the cached/provided cookie by calling GET /auth.
async function getSession(companyId, cookie) {
  const cached = tokenCache.get(String(companyId));
  const cookiePair = toCookiePair(cookie || (cached && cached.cookie));
  if (!cookiePair) return null;

  const url = `${BASE}/auth`;
  try{
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair,
      },
    });
    const body = await response.json().catch(() => ({}));
    const data = body.data || body;

    if (response.status === 200 && data.authenticated) {
      return { authenticated: true, cookie: cookiePair, user: data.user };
    }

    if (response.status === 404) {
      tokenCache.delete(String(companyId));
      return null;
    }

    logger.warn("ServiceTrade session validation failed", { status: response.status, messages: body.messages });
    return null;
  } catch (error) {
    throw buildFetchError(error, { companyId, method: "GET", path: "/auth" });
  }
}

// Ensure we have a valid session for the company; if not, login with provided credentials.
async function ensureSession(companyId, credentials) {
  const session = await getSession(companyId);
  if (session) return session.cookie;

  if (!credentials || !credentials.username || !credentials.password) return null;

  const result = await login(companyId, credentials.username, credentials.password);
  return result ? result.cookie : null;
}

// Make an authenticated request to the ServiceTrade API for a company.
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

  try{
    const response = await fetch(url, {
      method,
      headers,
      body: requestBody,
    });

    if ((response.status === 401 || response.status === 404) && credentials) {
      tokenCache.delete(String(companyId));
      cookie = await ensureSession(companyId, credentials);
      if (cookie) {
        headers.Cookie = cookie;
        response = await fetch(
          url,
          {
            method,
            headers,
            body: requestBody,
          });
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
  await fetch(
    url, {
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
  request,
  logout,
};
