/**
 * ServiceTrade API client (per-company)
 * Uses username/password auth; session token is sent as Cookie: PHPSESSID
 * @see api.servicetrade.com API docs - Authentication resource
 */

const config = require("../config");
const logger = require("../utils/logger");

const BASE = config.servicetrade.baseUrl;

// Per-company token cache: companyId -> { authToken }
const tokenCache = new Map();

/**
 * Login with username and password; cache token for company.
 * @param {string|number} companyId
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ authToken: string, user: object }|null>}
 */
async function login(companyId, username, password) {
  if (!username || !password) {
    logger.warn("ServiceTrade login: username and password required");
    return null;
  }

  const url = `${BASE}/auth`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  const body = await res.json().catch(() => ({}));
  const data = body.data || body;

  if (res.status === 200 && data.authenticated && data.authToken) {
    tokenCache.set(String(companyId), { authToken: data.authToken });
    logger.info("ServiceTrade login success", { companyId, username: username.replace(/.(?=.@)/g, "*") });
    return { authToken: data.authToken, user: data.user };
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
 * Get current session for a company (validate cached token).
 * @param {string|number} companyId
 * @param {string} [token] - If not provided, uses cached token for company
 * @returns {Promise<{ authenticated: boolean, authToken: string, user: object }|null>}
 */
async function getSession(companyId, token) {
  const cached = tokenCache.get(String(companyId));
  const authToken = token || (cached && cached.authToken);
  if (!authToken) return null;

  const url = `${BASE}/auth`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      Cookie: `PHPSESSID=${authToken}`,
    },
  });

  const body = await res.json().catch(() => ({}));
  const data = body.data || body;

  if (res.status === 200 && data.authenticated) {
    return { authenticated: true, authToken: data.authToken, user: data.user };
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
 * @returns {Promise<string|null>} - authToken or null
 */
async function ensureSession(companyId, credentials) {
  const session = await getSession(companyId);
  if (session) return session.authToken;

  if (!credentials || !credentials.username || !credentials.password) return null;

  const result = await login(companyId, credentials.username, credentials.password);
  return result ? result.authToken : null;
}

/**
 * Make an authenticated request to the ServiceTrade API for a company.
 * @param {string|number} companyId
 * @param {string} method - GET, POST, PUT, DELETE
 * @param {string} path - e.g. "/company/123"
 * @param {object} [options] - { body } for JSON body
 * @param {{ username: string, password: string }|null} [credentials] - for retry login
 * @returns {Promise<{ ok: boolean, status: number, data?: object, messages?: object }>}
 */
async function request(companyId, method, path, options = {}, credentials = null) {
  let token = await ensureSession(companyId, credentials);
  if (!token) {
    return { ok: false, status: 401, data: null, messages: { error: ["ServiceTrade not authenticated"] } };
  }

  const url = path.startsWith("http") ? path : `${BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = {
    "Content-Type": "application/json",
    Cookie: `PHPSESSID=${token}`,
    ...options.headers,
  };

  let res = await fetch(url, {
    method,
    headers,
    body: options.body != null ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined,
  });

  if ((res.status === 401 || res.status === 404) && credentials) {
    tokenCache.delete(String(companyId));
    token = await ensureSession(companyId, credentials);
    if (token) {
      headers.Cookie = `PHPSESSID=${token}`;
      res = await fetch(url, {
        method,
        headers,
        body: options.body != null ? (typeof options.body === "string" ? options.body : JSON.stringify(options.body)) : undefined,
      });
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
  };
}

/**
 * Logout (close session) for a company.
 * @param {string|number} companyId
 * @param {string} [token] - If not provided, uses cached token for company
 */
async function logout(companyId, token) {
  const cached = tokenCache.get(String(companyId));
  const authToken = token || (cached && cached.authToken);
  if (!authToken) return;

  const url = `${BASE}/auth`;
  await fetch(url, {
    method: "DELETE",
    headers: { Cookie: `PHPSESSID=${authToken}` },
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
