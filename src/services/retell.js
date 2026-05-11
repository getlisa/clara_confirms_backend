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

function buildLlmParams(callType, representativeName, companyName) {
  const repName = representativeName || "Clara";
  return {
    model: "claude-4.6-sonnet",
    start_speaker: "agent",
    general_prompt: callType.general_prompt ||
      `You are ${repName}, a scheduling assistant calling on behalf of ${companyName}. ${callType.description || ""}`.trim(),
    begin_message: callType.begin_message ||
      `Hi, this is ${repName} calling from ${companyName}. Is now a good time to talk?`,
  };
}

function buildAgentParams(llmId, companyName, callTypeName) {
  const slug = `${companyName}_${callTypeName}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .substring(0, 60);
  return {
    response_engine: { type: "retell-llm", llm_id: llmId },
    agent_name: slug,
    voice_id: config.retell.defaultVoiceId,
    language: "en-US",
    enable_backchannel: true,
    responsiveness: 1,
    interruption_sensitivity: 1,
    end_call_after_silence_ms: 600000,
    max_call_duration_ms: 3600000,
    voicemail_detection_enabled: true,
    voicemail_action: "hangup",
    post_call_analysis_model: "gpt-4.1-mini",
    post_call_analysis_data: POST_CALL_ANALYSIS_DATA,
  };
}

const POST_CALL_ANALYSIS_DATA = [
  { type: "system-presets", name: "call_summary" },
  { type: "system-presets", name: "call_successful" },
  { type: "system-presets", name: "user_sentiment" },
  {
    type: "enum",
    name: "appointment_confirmed",
    description: "Whether the customer confirmed their upcoming service appointment",
    choices: ["yes", "no", "unclear"],
  },
  {
    type: "boolean",
    name: "reschedule_requested",
    description: "Whether the customer asked to reschedule the appointment to a different time",
  },
  {
    type: "boolean",
    name: "cancellation_requested",
    description: "Whether the customer asked to cancel the appointment outright",
  },
];

/**
 * Provision or update the Retell LLM + Agent for a single call type.
 * Each call type has its own LLM + Agent stored on call_type_configs.
 * Idempotent — creates on first call, updates on subsequent calls.
 */
async function syncAgentForCallType(companyId, callType) {
  const client = getClient();

  const companyResult = await db.query(
    `SELECT c.name, cs.representative_name
     FROM companies c
     LEFT JOIN agent_settings cs ON cs.company_id = c.id
     WHERE c.id = $1`,
    [companyId]
  );
  const company = companyResult.rows[0];
  if (!company) throw new Error(`Company ${companyId} not found`);

  const llmParams = buildLlmParams(callType, company.representative_name, company.name);

  let { retell_llm_id: llmId, retell_agent_id: agentId } = callType;

  if (llmId) {
    await client.llm.update(llmId, llmParams);
    logger.info("Retell LLM updated", { companyId, callType: callType.type, llmId });
  } else {
    const llm = await client.llm.create(llmParams);
    llmId = llm.llm_id;
    logger.info("Retell LLM created", { companyId, callType: callType.type, llmId });
  }

  const agentParams = buildAgentParams(llmId, company.name, callType.type);

  if (agentId) {
    await client.agent.update(agentId, agentParams);
    logger.info("Retell Agent updated", { companyId, callType: callType.type, agentId });
  } else {
    const agent = await client.agent.create(agentParams);
    agentId = agent.agent_id;
    logger.info("Retell Agent created", { companyId, callType: callType.type, agentId });
  }

  // Persist IDs back to the call_type_configs row
  await db.query(
    `UPDATE call_type_configs
     SET retell_llm_id = $1, retell_agent_id = $2, updated_at = NOW()
     WHERE company_id = $3 AND type = $4`,
    [llmId, agentId, companyId, callType.type]
  );

  return { llmId, agentId };
}

/**
 * Verify Retell webhook signature. Returns true if valid.
 */
function verifyWebhookSignature(rawBody, signature) {
  try {
    if (!signature) return false;
    const secret = config.retell.webhookSecret || config.retell.apiKey;
    if (!secret) return false;
    return Retell.verify(rawBody, secret, signature);
  } catch {
    return false;
  }
}

/**
 * Initiate an outbound call via Retell for a specific call type.
 * Falls back to any provisioned agent for the company if callType not specified.
 */
async function createCall({ fromNumber, toNumber, companyId, callType, metadata = {} }) {
  const client = getClient();

  let agentId;

  if (callType) {
    const row = await db.query(
      `SELECT retell_agent_id FROM call_type_configs WHERE company_id = $1 AND type = $2`,
      [companyId, callType]
    );
    agentId = row.rows[0]?.retell_agent_id;
    if (!agentId) throw new Error(`No Retell agent provisioned for call type "${callType}" on company ${companyId}`);
  } else {
    // Fallback: use first available agent across call types
    const row = await db.query(
      `SELECT retell_agent_id FROM call_type_configs
       WHERE company_id = $1 AND retell_agent_id IS NOT NULL
       ORDER BY is_custom ASC, created_at ASC LIMIT 1`,
      [companyId]
    );
    agentId = row.rows[0]?.retell_agent_id;
    if (!agentId) throw new Error(`No Retell agent provisioned for company ${companyId}`);
  }

  const call = await client.call.createPhoneCall({
    from_number: fromNumber,
    to_number: toNumber,
    override_agent_id: agentId,
    metadata: { company_id: String(companyId), call_type: callType || null, ...metadata },
  });

  logger.info("Retell call initiated", { companyId, callType, callId: call.call_id, toNumber });
  return call;
}

module.exports = { syncAgentForCallType, verifyWebhookSignature, createCall, getClient };
