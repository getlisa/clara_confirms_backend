const Retell = require("retell-sdk");
const config = require("../config");
const db = require("../db");
const logger = require("../utils/logger");

let _client = null;

function getClient() {
  if (!config.retell.apiKey) throw new Error("RETELL_API_KEY is not configured");
  if (!_client) _client = new Retell({ apiKey: config.retell.apiKey });
  return _client;
}

/**
 * Verify Retell webhook signature.
 * Retell.verify() is ASYNC — returns Promise<boolean>. Must be awaited.
 * Retell signs payloads with the API key via HMAC-SHA256 with a timestamp.
 */
async function verifyWebhookSignature(rawBody, signature) {
  try {
    if (!signature) return false;

    // Try API key first, then webhook secret — Retell dashboard may configure either
    const keysToTry = [
      config.retell.apiKey,
      config.retell.webhookSecret,
    ].filter(Boolean);

    for (const key of keysToTry) {
      try {
        const valid = await Retell.verify(rawBody, key, signature);
        if (valid) return true;
      } catch {
        // try next key
      }
    }

    // Log signature info to help diagnose mismatches
    const sigPreview = signature?.slice(0, 30);
    const bodyLen = rawBody?.length ?? 0;
    logger.warn("Webhook signature mismatch", { sigPreview, bodyLen });
    return false;
  } catch {
    return false;
  }
}

/**
 * Initiate an outbound call via the company's flow-backed Retell agent.
 * Pass call_type and job dynamic variables so the flow routes to the right subagent.
 */
async function createCall({ fromNumber, toNumber, companyId, callType, dynamicVariables = {}, metadata = {} }) {
  if (!callType) throw new Error("callType is required — the branch router needs it to route to the correct subagent");

  const client = getClient();

  const result = await db.query(
    `SELECT retell_agent_id, retell_phone_number FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = result.rows[0];
  if (!company?.retell_agent_id) throw new Error(`No Retell agent provisioned for company ${companyId}`);
  const agentId = company.retell_agent_id;

  // Fall back to company's registered phone number if fromNumber not explicitly provided
  const resolvedFromNumber = fromNumber || company.retell_phone_number;
  if (!resolvedFromNumber) throw new Error(`No from_number available for company ${companyId} — set retell_phone_number on the company`);

  const call = await client.call.createPhoneCall({
    from_number: resolvedFromNumber,
    to_number: toNumber,
    override_agent_id: agentId,
    retell_llm_dynamic_variables: {
      call_type: callType || "",
      ...dynamicVariables,
    },
    metadata: { company_id: String(companyId), call_type: callType || null, ...metadata },
  });

  logger.info("Retell call initiated", { companyId, callType, callId: call.call_id, toNumber });
  return call;
}

module.exports = { verifyWebhookSignature, createCall, getClient };
