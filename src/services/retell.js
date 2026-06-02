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
    if (!signature) {
      logger.warn("Webhook: no x-retell-signature header");
      return false;
    }

    const valid = await Retell.verify(rawBody, config.retell.webhookSecret, signature);
    if (valid) return true;

    logger.warn("Webhook signature mismatch", { sigPreview: signature.slice(0, 30), bodyLen: rawBody?.length ?? 0 });
    return false;
  } catch (err) {
    logger.error("Webhook signature verify threw", { error: err.message });
    return false;
  }
}

/**
 * Initiate an outbound call via the company's flow-backed Retell agent.
 * Pass call_type and job dynamic variables so the flow routes to the right subagent.
 */
async function createCall({ fromNumber, toNumber, companyId, callType, dynamicVariables = {}, metadata = {}, voicemailMessage }) {
  if (!callType) throw new Error("callType is required — the branch router needs it to route to the correct subagent");

  const client = getClient();

  const result = await db.query(
    `SELECT retell_agent_id, retell_phone_number FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = result.rows[0];
  if (!company?.retell_agent_id) throw new Error(`No Retell agent provisioned for company ${companyId}`);
  const agentId = company.retell_agent_id;

  const resolvedFromNumber = fromNumber || company.retell_phone_number;
  if (!resolvedFromNumber) throw new Error(`No from_number available for company ${companyId} — set retell_phone_number on the company`);

  const callParams = {
    from_number: resolvedFromNumber,
    to_number: toNumber,
    override_agent_id: agentId,
    retell_llm_dynamic_variables: {
      call_type: callType || "",
      ...dynamicVariables,
    },
    metadata: { company_id: String(companyId), call_type: callType || null, ...metadata },
  };

  // Override voicemail message per call so each call type has context-appropriate wording
  if (voicemailMessage !== undefined) {
    callParams.agent_override = { voicemail_message: voicemailMessage };
  }

  const call = await client.call.createPhoneCall(callParams);

  logger.info("Retell call initiated", { companyId, callType, callId: call.call_id, toNumber });
  return call;
}

module.exports = { verifyWebhookSignature, createCall, getClient };
