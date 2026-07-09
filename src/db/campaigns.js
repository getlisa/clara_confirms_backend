const db = require("./index");

/**
 * Campaigns — the single config entity (merges the former call_trigger_configs +
 * call_type_configs). A campaign = trigger behavior (when/who) + its own agent
 * (prompt/greeting/voicemail) + Retell provisioning artifacts.
 *
 * The campaign KEY is the `trigger_type` column. It is the routing identity: it
 * flows to scheduled_calls.call_type, the Retell `{{call_type}}` dynamic variable,
 * and the sub-agent node id (`node_{key}`).
 */

const CAMPAIGN_KEYS = [
  "scheduled_unconfirmed",
  "quotation_pending",
  "open_job_due_soon",
  "technician_unconfirmed",
  "post_job_review",
];

// Built-in campaigns. `prompt_basis` selects the default prompt/greeting/voicemail
// text (historically the linked call_type slug).
const BUILTIN_SEEDS = [
  {
    key: "scheduled_unconfirmed", name: "Confirm Campaign", enabled: false,
    days_before: 2, trigger_config: { retry_if_no_answer: true }, prompt_basis: "customer_confirmation",
    description: "Call customer to confirm their upcoming appointment when job is scheduled but unconfirmed.",
  },
  {
    key: "quotation_pending", name: "Quote Follow Up Campaign", enabled: false,
    days_before: 3, trigger_config: { quote_statuses: ["sent", "viewed"], days_after_sent: 3 }, prompt_basis: "quotation_followup",
    description: "Follow up with customer on a sent or viewed quotation that hasn't been accepted yet.",
  },
  {
    key: "open_job_due_soon", name: "Booking Campaign", enabled: false,
    days_before: 7, trigger_config: { only_if_technician_assigned: false }, prompt_basis: "customer_confirmation",
    description: "Call customer when an open (unscheduled) job is approaching its due date.",
  },
  {
    key: "technician_unconfirmed", name: "Technician Confirm Campaign", enabled: false,
    days_before: 1, trigger_config: {}, prompt_basis: "technician_confirmation",
    description: "Call the assigned technician when a job is scheduled and they haven't confirmed availability yet.",
  },
  {
    key: "post_job_review", name: "Post Job Feedback Campaign", enabled: false,
    days_before: 1, trigger_config: { days_after: 1 }, prompt_basis: "post_job_review",
    description: "Call the customer after a completed appointment to check in and collect a review.",
  },
];

const PROMPT_BASIS = Object.fromEntries(BUILTIN_SEEDS.map((s) => [s.key, s.prompt_basis]));

/**
 * Default begin_message + general_prompt, keyed by prompt basis. Moved from the
 * retired call_type_configs module; `post_job_review` added.
 */
function generateDefaultPrompts(basis, name, description) {
  if (basis === "customer_confirmation") {
    return {
      begin_message:
        "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. " +
        "I'm reaching out about the {{job_name}} job scheduled for {{job_date}}. " +
        "Is now a good time to talk?",
      general_prompt:
        "[Opening — say this exactly when the call connects]:\n" +
        "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. " +
        "I'm reaching out about the {{job_name}} job scheduled for {{job_date}}. Is now a good time to talk?\n\n" +
        "You are {{representative_name}}, a friendly and professional scheduling assistant calling on behalf of {{company_name}}.\n\n" +
        "Current date and time: {{current_date}} at {{current_time}}\n\n" +
        "Job details for this call:\n" +
        "- Job: {{job_name}}\n- Description: {{job_description}}\n- Scheduled date: {{job_date}}\n" +
        "- Job ID: {{job_id}}\n- Appointment ID: {{appointment_id}}\n- Customer address: {{customer_address}}\n\n" +
        "━━━ YOUR MAIN WORKFLOW ━━━\n\n" +
        "STEP 0 — Handle 'not a good time' first. If the customer says they're busy or asks for a callback, ask for a better time, confirm you'll call back then, and end the call politely (the system schedules the callback). Do NOT proceed.\n\n" +
        "STEP 1 — Call get_job with job_id={{job_id}} to check the current appointment status.\n\n" +
        "STEP 2 — If an active appointment exists: confirm it (confirm_appointment), or reschedule (reschedule_appointment) / note a cancellation request. If none exists: offer to schedule (create_appointment) when the customer gives a time, else tell them the team will follow up.\n\n" +
        "━━━ GENERAL RULES ━━━\n- Always call get_job first. Answer job questions from {{job_description}}; defer anything else. Do not discuss pricing or contracts. Say goodbye only once resolved.",
    };
  }
  if (basis === "technician_confirmation") {
    return {
      begin_message:
        "Hi {{technician_name}}, this is {{representative_name}} from {{company_name}}. " +
        "I'm calling to confirm you're available for the {{job_name}} job on {{job_date}} at {{customer_address}}. " +
        "Do you have a moment?",
      general_prompt:
        "[Opening — say this exactly when the call connects]:\n" +
        "Hi {{technician_name}}, this is {{representative_name}} from {{company_name}}. " +
        "I'm calling to confirm you're available for the {{job_name}} job on {{job_date}} at {{customer_address}}. Do you have a moment?\n\n" +
        "You are {{representative_name}}, a scheduling coordinator calling on behalf of {{company_name}}.\n\n" +
        "Current date and time: {{current_date}} at {{current_time}}\n\n" +
        "Job details: {{job_name}} / {{job_description}} / Customer {{customer_name}} / {{customer_address}} / {{job_date}} / Job ID {{job_id}} / Appointment ID {{appointment_id}}\n\n" +
        "STEP 1 — Call get_job with job_id={{job_id}}.\n" +
        "STEP 2 — If the technician confirms availability, call confirm_appointment with appointment_id={{appointment_id}}. If unavailable, collect their availability and say the scheduling team will follow up (do NOT reschedule yourself).\n\n" +
        "Be professional and concise. Do not discuss pay or contracts. Say goodbye only once resolved.",
    };
  }
  if (basis === "quotation_followup") {
    return {
      begin_message:
        "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. " +
        "I'm following up on the quote we sent you for {{job_name}} — do you have a moment to discuss it?",
      general_prompt:
        "[Opening — say this exactly when the call connects]:\n" +
        "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. " +
        "I'm following up on the quote we sent you for {{job_name}} — do you have a moment to discuss it?\n\n" +
        "You are {{representative_name}}, a friendly representative for {{company_name}}.\n\n" +
        "Quote: {{job_name}} / Total {{total_amount}} / Job ID {{job_id}}\n\n" +
        "STEP 1 — Call get_quotation with job_id={{job_id}}.\n" +
        "STEP 2 — If ready to proceed, tell them the team will schedule the work (do NOT schedule yourself). Answer quote questions from the get_quotation result; defer pricing changes to the team. If they decline, note the reason and close respectfully.\n\n" +
        "Do not make pricing commitments or modify the quote. Do not schedule work on this call.",
    };
  }
  if (basis === "post_job_review") {
    return {
      begin_message:
        "Hi {{customer_name}}, this is {{representative_name}} from {{company_name}}. " +
        "I'm following up on the {{job_name}} we recently completed — do you have a quick moment?",
      general_prompt:
        "[Opening — say this exactly when the call connects]:\n" +
        "Hi {{customer_name}}, this is {{representative_name}} from {{company_name}}. " +
        "I'm following up on the {{job_name}} we recently completed — do you have a quick moment?\n\n" +
        "You are {{representative_name}}, a friendly representative for {{company_name}} checking in after a completed visit.\n\n" +
        "Job: {{job_name}} / Job ID {{job_id}}\n\n" +
        "Goal: confirm the customer was satisfied with the completed work and, if they're happy, invite them to leave a review. " +
        "If they raise an issue, apologize, capture the concern, and tell them the team will follow up. " +
        "Be warm and brief. Do not discuss pricing or schedule new work on this call.",
    };
  }
  // Generic fallback (should not normally be hit for built-in campaigns).
  return {
    begin_message:
      "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. " +
      `I'm reaching out regarding ${(name || "your service").toLowerCase()}. Is now a good time to talk?`,
    general_prompt:
      "You are {{representative_name}}, a professional assistant calling on behalf of {{company_name}}.\n\n" +
      `Purpose of this call: ${description || name || ""}\n\n` +
      "Introduce yourself, state the purpose concisely, be respectful of the customer's time, and offer a callback if they're busy.",
  };
}

function generateDefaultVoicemailMessage(basis) {
  switch (basis) {
    case "customer_confirmation":
      return "Hi {{customer_name}}, this is {{representative_name}} from {{company_name}}. " +
             "We were calling to confirm your upcoming service appointment. Please call us back at your earliest convenience. Thank you!";
    case "technician_confirmation":
      return "Hi {{technician_name}}, this is {{representative_name}} from {{company_name}}. " +
             "We were calling to confirm your availability for an upcoming job. Please call us back when you get a chance. Thank you!";
    case "quotation_followup":
      return "Hi {{customer_name}}, this is {{representative_name}} from {{company_name}}. " +
             "We were following up on a quote we recently sent you. Please call us back when you have a moment. Thank you!";
    case "post_job_review":
      return "Hi {{customer_name}}, this is {{representative_name}} from {{company_name}}. " +
             "We were checking in about the work we recently completed for you. Please call us back when you have a moment. Thank you!";
    default:
      return "Hi, this is {{representative_name}} from {{company_name}}. " +
             "We had a question for you and would love to connect. Please call us back at your earliest convenience. Thank you!";
  }
}

const SELECT_COLS =
  "trigger_type, enabled, call_type, days_before, trigger_config, begin_message, general_prompt, " +
  "name, voicemail_message, description, retell_llm_id, retell_agent_id, retell_subagent_node_id, updated_at";

function rowToObject(row) {
  const key = row.trigger_type;
  return {
    key,
    trigger_type:            key,
    name:                    row.name ?? key,
    enabled:                 row.enabled,
    days_before:             Number(row.days_before),
    trigger_config:          row.trigger_config ?? {},
    begin_message:           row.begin_message ?? null,
    general_prompt:          row.general_prompt ?? null,
    voicemail_message:       row.voicemail_message ?? generateDefaultVoicemailMessage(PROMPT_BASIS[key]),
    description:             row.description ?? null,
    retell_llm_id:           row.retell_llm_id ?? null,
    retell_agent_id:         row.retell_agent_id ?? null,
    retell_subagent_node_id: row.retell_subagent_node_id ?? null,
    updated_at:              row.updated_at,
  };
}

/** Seed the built-in campaigns for a new company (called at registration). */
async function seedBuiltins(companyId, client) {
  const run = client ?? db;
  for (const seed of BUILTIN_SEEDS) {
    const { begin_message, general_prompt } = generateDefaultPrompts(seed.prompt_basis, seed.name, seed.description);
    const voicemail_message = generateDefaultVoicemailMessage(seed.prompt_basis);
    await run.query(
      `INSERT INTO campaigns
         (company_id, trigger_type, enabled, call_type, days_before, trigger_config,
          begin_message, general_prompt, name, voicemail_message, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (company_id, trigger_type) DO NOTHING`,
      [
        companyId, seed.key, seed.enabled, seed.prompt_basis, seed.days_before,
        JSON.stringify(seed.trigger_config), begin_message, general_prompt,
        seed.name, voicemail_message, seed.description,
      ]
    );
  }
}

async function getAllByCompanyId(companyId) {
  const result = await db.query(
    `SELECT ${SELECT_COLS} FROM campaigns WHERE company_id = $1
     ORDER BY CASE trigger_type
       WHEN 'scheduled_unconfirmed' THEN 1
       WHEN 'quotation_pending'     THEN 2
       WHEN 'open_job_due_soon'     THEN 3
       WHEN 'technician_unconfirmed' THEN 4
       ELSE 5 END`,
    [companyId]
  );
  const saved = Object.fromEntries(result.rows.map((r) => [r.trigger_type, rowToObject(r)]));
  return CAMPAIGN_KEYS.map((k) => saved[k] ?? defaultCampaign(k));
}

async function getEnabledByCompanyId(companyId) {
  const result = await db.query(
    `SELECT ${SELECT_COLS} FROM campaigns WHERE company_id = $1 AND enabled = true`,
    [companyId]
  );
  return result.rows.map(rowToObject);
}

/** Single campaign by key (== trigger_type). Used by the dispatcher for voicemail + routing. */
async function getByKey(companyId, key) {
  const result = await db.query(
    `SELECT ${SELECT_COLS} FROM campaigns WHERE company_id = $1 AND trigger_type = $2`,
    [companyId, key]
  );
  return result.rows[0] ? rowToObject(result.rows[0]) : null;
}

function defaultCampaign(key) {
  const seed = BUILTIN_SEEDS.find((s) => s.key === key) ?? {};
  const { begin_message, general_prompt } = generateDefaultPrompts(seed.prompt_basis, seed.name, seed.description);
  return {
    key, trigger_type: key, name: seed.name ?? key, enabled: seed.enabled ?? false,
    days_before: seed.days_before ?? 1, trigger_config: seed.trigger_config ?? {},
    begin_message, general_prompt, voicemail_message: generateDefaultVoicemailMessage(seed.prompt_basis),
    description: seed.description ?? null, retell_llm_id: null, retell_agent_id: null,
    retell_subagent_node_id: null, updated_at: null,
  };
}

async function upsert(companyId, key, fields) {
  if (!CAMPAIGN_KEYS.includes(key)) {
    const err = new Error(`Invalid campaign key: ${key}`);
    err.status = 400;
    throw err;
  }
  const allowed = ["enabled", "days_before", "trigger_config", "begin_message", "general_prompt", "name", "voicemail_message"];
  const provided = Object.keys(fields).filter((k) => allowed.includes(k));
  if (provided.length === 0) return getByKey(companyId, key);

  const seed = BUILTIN_SEEDS.find((s) => s.key === key) ?? {};
  const { begin_message, general_prompt } = generateDefaultPrompts(seed.prompt_basis, seed.name, seed.description);

  const result = await db.query(
    `INSERT INTO campaigns
       (company_id, trigger_type, enabled, call_type, days_before, trigger_config,
        begin_message, general_prompt, name, voicemail_message, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (company_id, trigger_type) DO UPDATE SET
       ${provided.map((k, i) => `${k} = $${i + 12}`).join(", ")},
       updated_at = NOW()
     RETURNING ${SELECT_COLS}`,
    [
      companyId, key, seed.enabled ?? false, seed.prompt_basis ?? null, seed.days_before ?? 1,
      JSON.stringify(seed.trigger_config ?? {}), begin_message, general_prompt,
      seed.name ?? key, generateDefaultVoicemailMessage(seed.prompt_basis), seed.description ?? null,
      ...provided.map((k) => (k === "trigger_config" ? JSON.stringify(fields[k]) : fields[k])),
    ]
  );
  return rowToObject(result.rows[0]);
}

/** Store the Retell provisioning artifacts for a campaign (called by retell-flow). */
async function updateRetellIds(companyId, key, { retellLlmId, retellAgentId, retellSubagentNodeId }) {
  await db.query(
    `UPDATE campaigns
        SET retell_llm_id = $3, retell_agent_id = $4, retell_subagent_node_id = $5, updated_at = NOW()
      WHERE company_id = $1 AND trigger_type = $2`,
    [companyId, key, retellLlmId, retellAgentId, retellSubagentNodeId]
  );
}

module.exports = {
  CAMPAIGN_KEYS, BUILTIN_SEEDS, PROMPT_BASIS,
  generateDefaultPrompts, generateDefaultVoicemailMessage,
  seedBuiltins, getAllByCompanyId, getEnabledByCompanyId, getByKey, upsert, updateRetellIds,
};
