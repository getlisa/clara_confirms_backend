const { getProvider } = require("./crm");
const logger = require("../utils/logger");

// Make a logged ServiceTrade API call.
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
