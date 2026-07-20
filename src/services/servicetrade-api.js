/**
 * Uniform, logged ServiceTrade API access.
 *
 * Every ServiceTrade write-back (comments, service-link messages, contacts,
 * contact types) goes through `stLoggedRequest` so we always log — at INFO —
 * WHEN we call an API, WHAT payload we sent, and the STATUS + RESPONSE we got
 * back. This is deliberately verbose: production issues (e.g. comments silently
 * not posting) are far easier to diagnose when the request/response of each
 * ServiceTrade call is in the logs.
 *
 * Wraps the authenticated per-company client in
 * src/services/crm/servicetrade/provider.js (which handles the session cookie
 * + 401/404 re-auth). Base URL already ends in `/api`, so paths are like
 * "/comment", "/message", "/contact", "/contacttype".
 */

const { getProvider } = require("./crm");
const logger = require("../utils/logger");

/**
 * Make a logged ServiceTrade API call.
 *
 * @param {number|string} companyId
 * @param {"GET"|"POST"|"PUT"|"DELETE"} method
 * @param {string} path                      — e.g. "/comment", "/message?foo=1"
 * @param {object} [opts]
 * @param {object} [opts.body]               — JSON request body (POST/PUT)
 * @param {string} [opts.context]            — short label for the call site, e.g. "comment.post"
 * @returns {Promise<{ok:boolean, status:number, data:any, messages:object}>}
 */
async function stLoggedRequest(companyId, method, path, { body, context } = {}) {
  const label = context || "servicetrade";
  logger.info("servicetrade api →", {
    context: label,
    companyId,
    method,
    path,
    payload: body ?? null,
  });

  try {
    const provider = getProvider("servicetrade");
    const res = await provider.request(companyId, method, path, body != null ? { body } : {});
    logger.info("servicetrade api ←", {
      context: label,
      companyId,
      method,
      path,
      status: res.status,
      ok: res.ok,
      response: res.data ?? null,
      messages: res.messages ?? null,
    });
    return res;
  } catch (err) {
    logger.error("servicetrade api ✗", {
      context: label,
      companyId,
      method,
      path,
      error: err.message,
    });
    throw err;
  }
}

module.exports = { stLoggedRequest };
