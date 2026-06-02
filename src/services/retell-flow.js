/**
 * Retell Conversation Flow manager.
 *
 * Full provisioning per tenant on signup:
 *   1. Create ConversationFlow  (branch router → subagent nodes → end node)
 *   2. Create Agent             (response_engine: conversation-flow)
 *   3. Buy phone number         (auto-purchased, linked as outbound + inbound)
 *   4. Store all IDs on company
 *   5. Register default tools on each subagent node
 *   6. Sync full workflow prompts to each subagent node
 *
 * Every subsequent UI change (call type add/edit/delete, representative_name)
 * calls syncFlowForCompany again — idempotent, patches in place.
 */

const Retell = require("retell-sdk");
const config = require("../config");
const db = require("../db");
const agentSettingsDb = require("../db/agent-settings");
const logger = require("../utils/logger");

let _client = null;

function getClient() {
  if (!config.retell.apiKey) throw new Error("RETELL_API_KEY is not configured");
  if (!_client) _client = new Retell({ apiKey: config.retell.apiKey });
  return _client;
}

// ── Node ID conventions ────────────────────────────────────────────────────────

const NODE_ROUTER = "node_router";
const NODE_END    = "node_end";
const nodeId      = (slug) => `node_${slug}`;

// ── Post-call analysis (agent-level) ──────────────────────────────────────────

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
    description: "Whether the customer asked to reschedule the appointment",
  },
  {
    type: "boolean",
    name: "cancellation_requested",
    description: "Whether the customer asked to cancel the appointment outright",
  },
];

// ── Flow node builders ─────────────────────────────────────────────────────────

function buildBranchNode(callTypes) {
  return {
    id: NODE_ROUTER,
    type: "branch",
    name: "Call Type Router",
    // Cheapest model — this node never speaks, only evaluates equations silently
    model_choice: { type: "cascading", model: "gpt-4.1-nano" },
    edges: callTypes.map((ct) => ({
      id: `edge_${ct.type}`,
      destination_node_id: nodeId(ct.type),
      transition_condition: {
        type: "equation",
        operator: "&&",
        equations: [{ left: "{{call_type}}", operator: "==", right: ct.type }],
      },
    })),
    else_edge: {
      id: "edge_else",
      destination_node_id: NODE_END,
      // Retell API requires type "prompt" for else_edge (equation not accepted)
      transition_condition: {
        type: "prompt",
        prompt: "Else",
      },
    },
  };
}

// Per-call-type extract variable definitions
const EXTRACT_VARIABLES = {
  customer_confirmation: [
    {
      type: "enum", name: "customer_outcome", required: true,
      choices: ["confirmed", "rescheduled", "declined", "no_answer", "callback_requested", "appointment_needed"],
      description: "What the customer decided. Use 'appointment_needed' when no active appointment exists and customer gave no time preference. Use 'callback_requested' when customer asked to be called back at a specific time.",
    },
    {
      type: "string", name: "preferred_reschedule_date", required: false,
      description: "Date/time the customer wants to reschedule to.",
      conditional_prompt: "Only extract if customer_outcome is rescheduled",
    },
    {
      type: "string", name: "callback_time", required: false,
      description: "The specific time the customer requested for a callback, e.g. '1pm', 'in 30 minutes', '2:30 PM'. Only extract if customer asked to be called back at a particular time.",
      conditional_prompt: "Only extract if customer_outcome is callback_requested",
    },
    {
      type: "string", name: "customer_notes", required: false,
      description: "Any specific concerns, questions, or notes the customer mentioned.",
    },
  ],
  technician_confirmation: [
    {
      type: "enum", name: "technician_outcome", required: true,
      choices: ["confirmed", "unavailable", "need_to_check", "no_answer"],
      description: "Whether the technician confirmed availability for the job.",
    },
    {
      type: "string", name: "unavailability_reason", required: false,
      description: "Reason the technician gave for being unavailable.",
      conditional_prompt: "Only extract if technician_outcome is unavailable",
    },
    {
      type: "string", name: "technician_notes", required: false,
      description: "Any concerns or special notes the technician mentioned about the job.",
    },
  ],
  quotation_followup: [
    {
      type: "enum", name: "quote_decision", required: true,
      choices: ["accepted", "rejected", "needs_more_info", "callback_requested", "no_answer"],
      description: "What the customer decided about the quotation.",
    },
    {
      type: "string", name: "rejection_reason", required: false,
      description: "Reason the customer gave for rejecting or not accepting the quote.",
      conditional_prompt: "Only extract if customer rejected or hesitated on the quote",
    },
    {
      type: "string", name: "callback_time", required: false,
      description: "The specific time the customer requested for a callback.",
      conditional_prompt: "Only extract if quote_decision is callback_requested",
    },
    {
      type: "string", name: "customer_questions", required: false,
      description: "Any questions the customer asked about the quote or the work.",
    },
  ],
};

function extractNodeId(type) { return `extract_${type}`; }

function buildSubagentNode(callType) {
  const parts = [];
  if (callType.begin_message) {
    parts.push(`[Opening — say this exactly when the call connects]:\n${callType.begin_message}`);
  }
  if (callType.general_prompt) parts.push(callType.general_prompt);

  const extractId = extractNodeId(callType.type);
  const hasExtract = !!EXTRACT_VARIABLES[callType.type];

  return {
    id: nodeId(callType.type),
    type: "subagent",
    name: callType.name,
    model_choice: { type: "cascading", model: "claude-4.6-sonnet" },
    instruction: { type: "prompt", text: parts.join("\n\n") || `You are a scheduling assistant for {{company_name}}.` },
    edges: [
      {
        id: `edge_${callType.type}_to_${hasExtract ? extractId : NODE_END}`,
        destination_node_id: hasExtract ? extractId : NODE_END,
        transition_condition: {
          type: "prompt",
          prompt: "The agent has said a clear farewell such as 'goodbye', 'have a great day', 'take care', or 'talk to you soon', AND the customer has also said goodbye OR the customer has explicitly hung up. Do NOT transition if the customer has asked a question, requested a reschedule, expressed concerns, or if the conversation is still actively ongoing.",
        },
      },
    ],
  };
}

function buildExtractNode(callType) {
  const variables = EXTRACT_VARIABLES[callType.type];
  if (!variables) return null;
  return {
    id: extractNodeId(callType.type),
    type: "extract_dynamic_variables",
    name: `Extract ${callType.name} Outcome`,
    variables,
    edges: [{
      id: `edge_extract_${callType.type}_to_end`,
      destination_node_id: NODE_END,
      transition_condition: { type: "prompt", prompt: "Always" },
    }],
  };
}

function buildEndNode() {
  return { id: NODE_END, type: "end", name: "End Call" };
}

function buildFlowNodes(callTypes) {
  const extractNodes = callTypes.map(buildExtractNode).filter(Boolean);
  return [
    buildBranchNode(callTypes),
    ...callTypes.map(buildSubagentNode),
    ...extractNodes,
    buildEndNode(),
  ];
}

// Dynamic variable catalog is now loaded from the `dynamic_variable_definitions` DB table.
// See src/db/dynamic-variable-definitions.js — buildDefaultsForCompany().
const dynamicVarsDb = require("../db/dynamic-variable-definitions");

// ── Phone number purchase ──────────────────────────────────────────────────────

/**
 * Purchase a Retell phone number and bind it to the agent (outbound + inbound).
 * Returns the purchased phone number string.
 */
async function buyAndLinkPhoneNumber(agentId, companyName, areaCode) {
  const client = getClient();

  if (!areaCode) {
    throw new Error(
      `Cannot purchase phone number for "${companyName}" — office_area_code is not set. ` +
      `Set the company's office address (state) or explicitly set office_area_code via PATCH /company.`
    );
  }

  const purchaseParams = {
    nickname: `Clara — ${companyName}`.substring(0, 50),
    country_code: config.retell.phoneCountryCode || "US",
    area_code: areaCode,
    outbound_agents: [{ agent_id: agentId, weight: 1 }],
    inbound_agents:  [{ agent_id: agentId, weight: 1 }],
  };

  const phoneResponse = await client.phoneNumber.create(purchaseParams);
  logger.info("Retell phone number purchased", {
    phoneNumber: phoneResponse.phone_number,
    agentId,
    companyName,
  });
  return phoneResponse.phone_number;
}

// ── Main sync function ─────────────────────────────────────────────────────────

/**
 * Provision or update the complete Retell setup for a company:
 *   ConversationFlow → Agent → Phone number (auto-bought on first run)
 *
 * Idempotent — safe to call on every UI change.
 */
async function syncFlowForCompany(companyId) {
  const client = getClient();

  const [companyResult, callTypesResult, agentSettingsResult] = await Promise.all([
    db.query(
      `SELECT name, retell_agent_id, retell_conversation_flow_id, retell_phone_number, office_area_code
       FROM companies WHERE id = $1`,
      [companyId]
    ),
    db.query(
      // Only include enabled call types — disabled ones get no subagent node
      `SELECT type, name, description, enabled, begin_message, general_prompt
       FROM call_type_configs
       WHERE company_id = $1 AND enabled = true
       ORDER BY is_custom ASC, created_at ASC`,
      [companyId]
    ),
    db.query(
      `SELECT representative_name FROM agent_settings WHERE company_id = $1`,
      [companyId]
    ),
  ]);

  const company = companyResult.rows[0];
  if (!company) throw new Error(`Company ${companyId} not found`);

  const callTypes   = callTypesResult.rows;
  const repName     = agentSettingsResult.rows[0]?.representative_name || "Clara";
  const companyName = company.name;

  if (callTypes.length === 0) {
    logger.warn("syncFlowForCompany: no enabled call types — skipping Retell sync", { companyId });
    return null;
  }

  const isFirstProvision = !company.retell_conversation_flow_id;
  const nodes = buildFlowNodes(callTypes);
  // Load full catalog from DB, then layer company-specific values on top
  const defaultDynVars = await dynamicVarsDb.buildDefaultsForCompany({
    companyName,
    representativeName: repName,
  });

  // ── Step 1: ConversationFlow ────────────────────────────────────────────────
  let flowId = company.retell_conversation_flow_id;

  if (flowId) {
    await client.conversationFlow.update(flowId, {
      nodes,
      start_node_id:             NODE_ROUTER,
      start_speaker:             "agent",
      default_dynamic_variables: defaultDynVars,
      model_choice:              { type: "cascading", model: "gpt-4.1-nano" },
    });
    logger.info("Retell ConversationFlow updated", { companyId, flowId, nodeCount: nodes.length });
  } else {
    const flow = await client.conversationFlow.create({
      nodes,
      start_node_id:             NODE_ROUTER,
      start_speaker:             "agent",
      default_dynamic_variables: defaultDynVars,
      model_choice:              { type: "cascading", model: "gpt-4.1-nano" },
    });
    flowId = flow.conversation_flow_id;
    logger.info("Retell ConversationFlow created", { companyId, flowId, nodeCount: nodes.length });
  }

  // ── Step 2: Agent ───────────────────────────────────────────────────────────
  let agentId = company.retell_agent_id;

  const agentParams = {
    response_engine: { type: "conversation-flow", conversation_flow_id: flowId },
    agent_name: `CLARA_${companyName.toUpperCase().replace(/[^A-Z0-9]+/g, "_").substring(0, 40)}`,
    voice_id:                    config.retell.defaultVoiceId,
    language:                    "en-US",
    enable_backchannel:          true,
    responsiveness:              1,
    interruption_sensitivity:    1,
    end_call_after_silence_ms:   600000,
    max_call_duration_ms:        3600000,
    voicemail_detection_enabled: true,
    voicemail_action:            "hangup",
    post_call_analysis_model:    "gpt-4.1-mini",
    post_call_analysis_data:     POST_CALL_ANALYSIS_DATA,
    ...(config.retell.webhookUrl ? { webhook_url: config.retell.webhookUrl } : {}),
  };

  if (agentId) {
    await client.agent.update(agentId, agentParams);
    logger.info("Retell Agent updated", { companyId, agentId });
  } else {
    const agent = await client.agent.create(agentParams);
    agentId = agent.agent_id;
    logger.info("Retell Agent created", { companyId, agentId });
  }

  // ── Step 3: Phone number ────────────────────────────────────────────────────
  let phoneNumber = company.retell_phone_number;

  if (isFirstProvision && !phoneNumber) {
    // Auto-buy on first provisioning using the company's office area code
    const areaCode = company.office_area_code;
    try {
      phoneNumber = await buyAndLinkPhoneNumber(agentId, companyName, areaCode);
    } catch (err) {
      // Non-fatal — admin can set office_area_code and call POST /agent-settings/sync-flow
      logger.warn("Failed to auto-purchase phone number during provisioning", {
        companyId,
        areaCode: areaCode ?? "not set",
        error: err.message,
      });
    }
  } else if (phoneNumber) {
    // Re-link existing number to (potentially new) agent on subsequent syncs
    try {
      await client.phoneNumber.update(phoneNumber, {
        outbound_agents: [{ agent_id: agentId, weight: 1 }],
        inbound_agents:  [{ agent_id: agentId, weight: 1 }],
      });
      logger.info("Retell phone number re-linked to agent", { companyId, phoneNumber, agentId });
    } catch (err) {
      logger.warn("Failed to re-link phone number to agent", { companyId, phoneNumber, error: err.message });
    }
  }

  // ── Step 4: Update agent_settings and call_type_configs with Retell IDs ────
  // subagent_count = number of enabled call types actually pushed to the flow
  await agentSettingsDb.updateRetellIds(companyId, {
    retellAgentId:            agentId,
    retellConversationFlowId: flowId,
    subagentCount:            callTypes.length,
  });

  // Stamp each call_type_config row with the node ID, agent ID, and flow ID
  for (const ct of callTypes) {
    await db.query(
      `UPDATE call_type_configs
       SET retell_subagent_node_id = $1,
           retell_agent_id         = $2,
           retell_llm_id           = $3,
           updated_at              = NOW()
       WHERE company_id = $4 AND type = $5`,
      [`node_${ct.type}`, agentId, flowId, companyId, ct.type]
    );
  }

  // ── Step 5: Fetch confirmed snapshots from Retell ──────────────────────────
  // Retrieve the full confirmed configurations so our DB reflects exactly
  // what is live in Retell — not just what we intended to push.
  let agentSnapshot = null;
  let flowSnapshot  = null;
  try {
    const [agentDetails, flowDetails] = await Promise.all([
      client.agent.retrieve(agentId),
      client.conversationFlow.retrieve(flowId),
    ]);
    agentSnapshot = agentDetails;
    flowSnapshot  = flowDetails;
  } catch (err) {
    logger.warn("Failed to fetch Retell snapshots after sync", { companyId, error: err.message });
  }

  // ── Step 6: Persist IDs, snapshots, and sync timestamp ─────────────────────
  // retell_llm_id is the legacy column — repopulated with the flow ID so the
  // companies table has a consistent, fully-mapped Retell picture.
  await db.query(
    `UPDATE companies
     SET retell_conversation_flow_id = $1,
         retell_agent_id             = $2,
         retell_llm_id               = $1,
         retell_phone_number         = COALESCE($3, retell_phone_number),
         retell_agent_snapshot       = $4,
         retell_flow_snapshot        = $5,
         retell_last_synced_at       = NOW(),
         updated_at                  = NOW()
     WHERE id = $6`,
    [
      flowId,
      agentId,
      phoneNumber || null,
      agentSnapshot ? JSON.stringify(agentSnapshot) : null,
      flowSnapshot  ? JSON.stringify(flowSnapshot)  : null,
      companyId,
    ]
  );

  // ── Step 7: Attach default tools + full workflow prompts ─────────────────────
  // Must run AFTER IDs are stamped to call_type_configs (Step 4) so the
  // tool/prompt services can look up retell_llm_id and retell_subagent_node_id.
  try {
    const { registerToolsForCompany } = require("./retell-tools");
    await registerToolsForCompany(companyId);
    logger.info("syncFlowForCompany: tools registered", { companyId });
  } catch (err) {
    logger.warn("syncFlowForCompany: tool registration failed (non-fatal)", { companyId, error: err.message });
  }

  try {
    const { syncPromptsForCompany } = require("./prompt-sync");
    await syncPromptsForCompany(companyId);
    logger.info("syncFlowForCompany: prompts synced", { companyId });
  } catch (err) {
    logger.warn("syncFlowForCompany: prompt sync failed (non-fatal)", { companyId, error: err.message });
  }

  logger.info("Retell provisioning complete", {
    companyId,
    flowId,
    agentId,
    phoneNumber:     phoneNumber || "not set",
    callTypesInFlow: callTypes.map((ct) => ct.type),
    snapshotsSaved:  !!(agentSnapshot && flowSnapshot),
    isFirstProvision,
  });

  return { flowId, agentId, phoneNumber: phoneNumber || null };
}

module.exports = { syncFlowForCompany };
