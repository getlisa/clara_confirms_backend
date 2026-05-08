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
 * Build Retell LLM params from agent_settings row.
 */
function buildLlmParams(agentSettings, companyName) {
  const repName = agentSettings.representative_name || "Clara";
  return {
    model: "claude-4.6-sonnet",
    start_speaker: "agent",
    general_prompt: agentSettings.general_prompt ||
      `You are ${repName}, a friendly and professional scheduling assistant calling on behalf of ${companyName}. Your goal is to confirm the customer's upcoming service appointment.`,
    begin_message: agentSettings.begin_message ||
      `Hi, this is ${repName} calling from ${companyName}. I'm reaching out to confirm your upcoming service appointment. Is now a good time to talk?`,
  };
}

const POST_CALL_ANALYSIS_DATA = [
  // System presets
  { type: "system-presets", name: "call_summary" },
  { type: "system-presets", name: "call_successful" },
  { type: "system-presets", name: "user_sentiment" },
  // Confirmation-specific fields
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
 * Build Retell Agent params.
 */
function buildAgentParams(llmId, companyName) {
  return {
    response_engine: { type: "retell-llm", llm_id: llmId },
    agent_name: `CONFIRM_${companyName.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
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

/**
 * Provision a Retell LLM + Agent for a company. Stores IDs back to the companies table.
 * Idempotent: if IDs already exist, updates the LLM/agent in place.
 */
async function syncAgentForCompany(companyId, agentSettings) {
  const client = getClient();

  const companyResult = await db.query(
    `SELECT name, retell_agent_id, retell_llm_id FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = companyResult.rows[0];
  if (!company) throw new Error(`Company ${companyId} not found`);

  const companyName = company.name;
  const llmParams = buildLlmParams(agentSettings, companyName);
  const existingLlmId = company.retell_llm_id;
  const existingAgentId = company.retell_agent_id;

  let llmId = existingLlmId;
  let agentId = existingAgentId;

  if (existingLlmId) {
    await client.llm.update(existingLlmId, llmParams);
    logger.info("Retell LLM updated", { companyId, llmId: existingLlmId });
  } else {
    const llm = await client.llm.create(llmParams);
    llmId = llm.llm_id;
    logger.info("Retell LLM created", { companyId, llmId });
  }

  const agentParams = buildAgentParams(llmId, companyName);

  if (existingAgentId) {
    await client.agent.update(existingAgentId, agentParams);
    logger.info("Retell Agent updated", { companyId, agentId: existingAgentId });
  } else {
    const agent = await client.agent.create(agentParams);
    agentId = agent.agent_id;
    logger.info("Retell Agent created", { companyId, agentId });
  }

  if (!existingLlmId || !existingAgentId) {
    await db.query(
      `UPDATE companies SET retell_llm_id = $1, retell_agent_id = $2, updated_at = NOW() WHERE id = $3`,
      [llmId, agentId, companyId]
    );
  }

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
 * Initiate an outbound call via Retell.
 */
async function createCall({ fromNumber, toNumber, companyId, metadata = {} }) {
  const client = getClient();

  const companyResult = await db.query(
    `SELECT retell_agent_id FROM companies WHERE id = $1`,
    [companyId]
  );
  const company = companyResult.rows[0];
  if (!company?.retell_agent_id) {
    throw new Error(`No Retell agent provisioned for company ${companyId}`);
  }

  const call = await client.call.createPhoneCall({
    from_number: fromNumber,
    to_number: toNumber,
    override_agent_id: company.retell_agent_id,
    metadata: { company_id: String(companyId), ...metadata },
  });

  logger.info("Retell call initiated", { companyId, callId: call.call_id, toNumber });
  return call;
}

module.exports = { syncAgentForCompany, verifyWebhookSignature, createCall, getClient };
