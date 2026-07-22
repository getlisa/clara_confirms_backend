const db = require("./index");

const BUILTIN_TYPES = [
  "customer_confirmation",
  "technician_confirmation",
  "technician_reschedule",
  "quotation_followup",
  "service_opportunity_followup",
];

const BUILTIN_SEEDS = [
  {
    type: "customer_confirmation",
    name: "Customer Confirmation",
    description: "Call the end customer to confirm their upcoming appointment.",
    enabled: true,
  },
  {
    type: "technician_confirmation",
    name: "Technician Confirmation",
    description: "Call the assigned technician to confirm availability for the job.",
    enabled: true,
  },
  {
    type: "technician_reschedule",
    name: "Technician Reschedule Notice",
    description: "Notify the technician that their job needs to be rescheduled.",
    enabled: false,
  },
  {
    type: "quotation_followup",
    name: "Quotation Follow-up",
    description: "Follow up with the customer on a sent or viewed quotation that hasn't been accepted yet.",
    enabled: false,
  },
  {
    type: "service_opportunity_followup",
    name: "Service Opportunity Follow Up",
    description: "Call the customer about open, unbooked service opportunities at one of their locations to get them booked.",
    enabled: false,
  },
];

/**
 * Generate default begin_message and general_prompt for a call type.
 * Built-in types get tailored prompts; custom types get generic ones derived
 * from the type's name and description.
 */
function generateDefaultPrompts(type, name, description) {
  if (type === "customer_confirmation") {
    return {
      begin_message:
        "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. " +
        "I'm reaching out about the {{job_name}} job scheduled for {{job_date}}. " +
        "Is now a good time to talk?",
      general_prompt:
        "[Opening — say this exactly when the call connects]:\n" +
        "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. " +
        "I'm reaching out about the job scheduled for {{job_date}}. Is now a good time to talk?\n\n" +
        "You are {{representative_name}}, a friendly and professional scheduling assistant calling on behalf of {{company_name}}.\n\n" +
        "Current date and time: {{current_date}} at {{current_time}}\n\n" +
        "Job details for this call:\n" +
        "- Job: {{job_name}}\n" +
        "- Description: {{job_description}}\n" +
        "- Scheduled date: {{job_date}}\n" +
        "- Customer address: {{customer_address}}\n\n" +
        "━━━ YOUR MAIN WORKFLOW ━━━\n\n" +
        "STEP 0 — Handle 'not a good time' first.\n" +
        "If the customer responds to the opening with something like \"I'm busy\", \"not now\", \"can you call me back\", \"call me in X minutes\", \"call me at [time]\":\n" +
        "  → Ask if they want a specific time: \"No problem — when would be a better time to call you back?\"\n" +
        "  → Once they give a time (\"in 20 minutes\", \"at 3 PM\", \"in an hour\"), say:\n" +
        "       \"Got it — I'll call you back then. Talk to you soon!\"\n" +
        "  → End the call politely. Do NOT proceed to STEP 1.\n" +
        "  → The system will automatically schedule a callback at the time they mentioned.\n" +
        "  → If they decline to give a specific time but want a callback later, treat as 'call back later' — say\n" +
        "    \"Our team will reach out again at a better time\" and end the call.\n\n" +
        "STEP 1 — Call the get_job tool with job_id={{job_id}} to check the current appointment status.\n" +
        "  → If {{appointment_id}} is provided above, ALSO call get_appointment with appointment_id={{appointment_id}} for the most precise service details tied to that specific appointment (a job can have more than one appointment/service).\n\n" +
        "STEP 1b — Use the `services` field from the tool result(s) to know what this call is actually about.\n" +
        "  → Each entry has service_line (e.g. \"Sprinkler / Fire Protection\") and description (e.g. \"Fix the broken flanges\").\n" +
        "  → When you have a resolved service, refer to it SPECIFICALLY when talking with the customer — e.g. \"your Sprinkler inspection\" or \"the fix for the broken flanges\" — instead of just a bare job number or generic job title.\n" +
        "  → If `services` is empty, fall back to {{job_name}} / {{job_description}} as before.\n\n" +
        "STEP 2 — Based on the result:\n\n" +
        "── CASE A: Job has an active appointment (has_active_appointment = true) ──────────\n" +
        "The appointment already exists. Your goal is to confirm it.\n\n" +
        "  If customer CONFIRMS they will be available:\n" +
        "    → Call confirm_appointment with the appointment_id from the get_job result.\n" +
        "    → Say: \"Great, I've confirmed your [specific service, e.g. Sprinkler inspection] for [date]!\" — reference the resolved service from STEP 1b when you have one.\n" +
        "    → Then go to the SERVICE LINK section below.\n\n" +
        "  If customer wants to RESCHEDULE:\n" +
        "    → Ask: \"What date and time works best for you?\"\n" +
        "    → Call reschedule_appointment with appointment_id and the new scheduled_start (format: YYYY-MM-DDTHH:MM:SS).\n" +
        "    → Confirm the new time back to the customer.\n\n" +
        "  If customer wants to CANCEL outright (not reschedule):\n" +
        "    → Ask: \"Just to confirm — would you like to cancel just this appointment, or do you not need this job at all anymore?\"\n" +
        "    → Ask: \"Can I ask why you'd like to cancel?\" and note their reason.\n" +
        "    → Call cancel_appointment with the appointment_id, scope ('appointment_only' or 'entire_job' based on their answer), and reason.\n" +
        "    → Confirm back: \"No problem, that's cancelled for you.\"\n\n" +
        "── CASE B: No active appointment (has_active_appointment = false) ──────────────────\n" +
        "No appointment has been booked yet. Your goal is to schedule one.\n\n" +
        "  Ask the customer: \"We'd like to get that scheduled for you — do you have a preferred date and time for [the specific service from STEP 1b, or {{job_name}} if none resolved]?\"\n\n" +
        "  If customer GIVES a time preference:\n" +
        "    → Call create_appointment with job_id={{job_id}} and their preferred scheduled_start (format: YYYY-MM-DDTHH:MM:SS, in the customer's local time).\n" +
        "    → Confirm back: \"I've scheduled your appointment for [date and time]. Our team will be there!\"\n\n" +
        "  If customer has NO preference or says \"anytime\" / \"whatever works\":\n" +
        "    → Say: \"No problem at all — our scheduling team will reach out soon to confirm a time that works for everyone.\"\n" +
        "    → Do NOT create an appointment. End the call politely.\n" +
        "    → (The system will automatically create a follow-up action for the team to book this appointment.)\n\n" +
        "━━━ SERVICE LINK (only AFTER the customer confirms the appointment) ━━━\n" +
        "Offer to email them a link to track this job:\n" +
        "  → Ask: \"Would you like me to email you a service link where you can follow this job?\"\n" +
        "  → If NO: skip this section and wrap up.\n" +
        "  → If YES:\n" +
        "     1. Ask for the email address to send it to and confirm the spelling back to them.\n" +
        "     2. Ask who this is for / their role (e.g. management, billing, on-site, scheduling, owner).\n" +
        "     3. Call search_contact with the email or their name to see if they already exist.\n" +
        "        • If a match is found, confirm the name/email with the customer, then call create_contact with existing_contact_id set to that contact's id and email set to the confirmed email.\n" +
        "        • If NO match, call create_contact with first_name, last_name, email, and role (their stated role) to create a new contact.\n" +
        "     4. Say: \"Perfect — I'll send that link to [email] right after we finish up.\"\n" +
        "  → Do NOT try to send the link yourself; recording the recipient is enough — the system emails it after the call.\n\n" +
        "━━━ GENERAL RULES ━━━\n" +
        "- Always call get_job first before taking any action.\n" +
        "- If the customer has questions about the job, answer based on {{job_description}} — for anything beyond that, say the team will follow up.\n" +
        "- Do not discuss pricing, contracts, or anything outside scheduling.\n" +
        "- Only say goodbye once the conversation is fully resolved.",
    };
  }

  if (type === "technician_confirmation") {
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
        "Job details for this call:\n" +
        "- Job: {{job_name}}\n" +
        "- Description: {{job_description}}\n" +
        "- Customer: {{customer_name}}\n" +
        "- Location: {{customer_address}}\n" +
        "- Scheduled date: {{job_date}}\n" +
        "- Job ID: {{job_id}}\n" +
        "- Appointment ID: {{appointment_id}}\n\n" +
        "━━━ YOUR MAIN WORKFLOW ━━━\n\n" +
        "STEP 1 — Call the get_job tool with job_id={{job_id}} to confirm current job details.\n\n" +
        "STEP 2 — Confirm availability:\n\n" +
        "  If technician CONFIRMS availability:\n" +
        "    → Call confirm_appointment with appointment_id={{appointment_id}} to record confirmation.\n" +
        "    → Say: \"Great, you're confirmed for the {{job_name}} on {{job_date}}. See you there!\"\n\n" +
        "  If technician is UNAVAILABLE:\n" +
        "    → Ask: \"When would you be available?\"\n" +
        "    → Note their availability and say: \"I'll pass this on to the scheduling team who will follow up.\"\n" +
        "    → Do NOT reschedule yourself.\n\n" +
        "  If technician has QUESTIONS about the job:\n" +
        "    → Answer based on {{job_description}} and the get_job result.\n" +
        "    → For anything beyond that, say the team will follow up.\n\n" +
        "━━━ GENERAL RULES ━━━\n" +
        "- Be professional and concise.\n" +
        "- Do not discuss pay, contracts, or anything outside of availability confirmation.\n" +
        "- Only say goodbye once the conversation is fully resolved.",
    };
  }

  if (type === "technician_reschedule") {
    return {
      begin_message:
        "Hi {{technician_name}}, this is {{representative_name}} from {{company_name}}. " +
        "I'm calling regarding the {{job_name}} job on {{job_date}} at {{customer_address}} — " +
        "we need to discuss rescheduling. Do you have a moment?",
      general_prompt:
        "[Opening — say this exactly when the call connects]:\n" +
        "Hi {{technician_name}}, this is {{representative_name}} from {{company_name}}. " +
        "I'm calling regarding the {{job_name}} job on {{job_date}} at {{customer_address}} — we need to discuss rescheduling. Do you have a moment?\n\n" +
        "You are {{representative_name}}, a scheduling coordinator calling on behalf of {{company_name}}.\n\n" +
        "Current date and time: {{current_date}} at {{current_time}}\n\n" +
        "Job details:\n" +
        "- Job: {{job_name}}\n" +
        "- Customer: {{customer_name}}\n" +
        "- Location: {{customer_address}}\n" +
        "- Original date: {{job_date}}\n" +
        "- Job ID: {{job_id}}\n\n" +
        "Your goal is to notify the technician that the job needs rescheduling and collect their availability.\n\n" +
        "When calling:\n" +
        "- Explain clearly that the job needs to be rescheduled.\n" +
        "- Ask for their availability: \"What dates and times work for you in the coming days?\"\n" +
        "- Note the times they provide.\n" +
        "- Reassure them: \"I'll pass this to the scheduling team who will confirm the new time.\"\n" +
        "- Be empathetic and professional.\n" +
        "- Do not confirm a new time yourself.",
    };
  }

  if (type === "quotation_followup") {
    return {
      begin_message:
        "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. " +
        "I'm following up on the quote we sent you for {{job_name}} — do you have a moment to discuss it?",
      general_prompt:
        "[Opening — say this exactly when the call connects]:\n" +
        "Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. " +
        "I'm following up on the quote we sent you for {{job_name}} — do you have a moment to discuss it?\n\n" +
        "You are {{representative_name}}, a friendly and professional representative calling on behalf of {{company_name}}.\n\n" +
        "Quote details for this call:\n" +
        "- Quote for: {{job_name}}\n" +
        "- Total amount: {{total_amount}}\n" +
        "- Job ID: {{job_id}}\n\n" +
        "━━━ YOUR MAIN WORKFLOW ━━━\n\n" +
        "STEP 1 — Call the get_quotation tool with job_id={{job_id}} to fetch full quote details.\n\n" +
        "STEP 2 — Based on the customer's response:\n\n" +
        "  If customer is READY TO PROCEED:\n" +
        "    → Say: \"That's great news! I'll let the team know and they'll be in touch to schedule the work.\"\n" +
        "    → Do NOT schedule anything yourself.\n\n" +
        "  If customer has QUESTIONS about the quote:\n" +
        "    → Answer based on the get_quotation result (line items, scope, validity).\n" +
        "    → For pricing changes or special requests: \"I'll pass that on to the team who can review it for you.\"\n\n" +
        "  If customer wants to DECLINE:\n" +
        "    → Thank them politely and ask if they'd like to share their reason.\n" +
        "    → Note the reason and close the call respectfully.\n\n" +
        "  If customer asks for a CALLBACK or more time:\n" +
        "    → Acknowledge and say the team will follow up.\n\n" +
        "━━━ GENERAL RULES ━━━\n" +
        "- Do not make pricing commitments or modify the quote.\n" +
        "- Do not schedule work during this call — that is a separate step.\n" +
        "- Be professional, friendly, and respect the customer's decision.",
    };
  }

  if (type === "service_opportunity_followup") {
    return {
      begin_message:
        "Hi, this is {{representative_name}} calling from {{company_name}} for {{customer_name}}. " +
        "I'm following up on some recommended service work at {{location_name}} — is now an okay time?",
      general_prompt:
        "[Opening — say this exactly when the call connects]:\n" +
        "Hi, this is {{representative_name}} calling from {{company_name}} for {{customer_name}}. " +
        "I'm following up on some recommended service work at {{location_name}} — is now an okay time?\n\n" +
        "You are {{representative_name}}, a warm, consultative service advisor calling on behalf of {{company_name}}. " +
        "This is NOT an appointment-confirmation call — no appointment exists yet. Your goal is to walk the customer " +
        "through open service recommendations for one of their sites and get the ones they want onto the schedule.\n\n" +
        "Current date and time: {{current_date}} at {{current_time}}\n\n" +
        "━━━ WHO YOU'RE CALLING ━━━\n" +
        "- Account: {{customer_name}}\n" +
        "- Site / location: {{location_name}} — {{location_address}}\n" +
        "- Site primary contact: {{primary_contact_name}}\n" +
        "- Site general manager: {{general_manager_name}}\n" +
        "- Number of open recommendations for this site: {{service_opportunity_count}}\n" +
        "(If the person who answers isn't the right contact, politely ask for the primary contact or general manager by name if provided.)\n\n" +
        "━━━ HOW TO RUN THE CALL ━━━\n\n" +
        "STEP 0 — If it's a bad time, offer to call back. If they name a time, acknowledge and end politely (the system books the callback automatically). Don't push through.\n\n" +
        "STEP 1 — Call the get_service_opportunities tool FIRST to load the recommendations for this call. It returns, for each item: its id, the work, why_recommended (the inspection deficiency), estimated_price, recurring_service, and requested_window. Do not guess these — always fetch them.\n\n" +
        "STEP 2 — Go through the recommendations conversationally, one at a time. For each: briefly say what it is and WHY it's recommended (use why_recommended — this is your strongest point), then ask if they'd like to get it scheduled.\n\n" +
        "STEP 3 — Respond to the customer:\n" +
        "  • WANTS IT (with or without a preferred date):\n" +
        "     → Call book_service_opportunity with that item's service_opportunity_id (and preferred_date + notes if given).\n" +
        "     → Confirm: \"Great — I've got that down, our team will reach out to lock in the exact timing.\"\n" +
        "  • PRICE PUSHBACK / wants an exact quote:\n" +
        "     → Do NOT commit to or change pricing. Say the estimate is approximate and the team will confirm the final number. If they still want it done, book it.\n" +
        "  • 'WHY DO I NEED THIS?':\n" +
        "     → Explain using the deficiency / inspection reason for that item. If it's a recurring service, note it's part of their regular maintenance.\n" +
        "  • DECLINES an item:\n" +
        "     → Acknowledge graciously, don't pressure, move on.\n" +
        "  • NEEDS TO THINK / check with someone:\n" +
        "     → Fine — let them know the team will follow up, and move on.\n\n" +
        "STEP 4 — At the end, recap which items they agreed to and thank them.\n\n" +
        "━━━ GENERAL RULES ━━━\n" +
        "- Only call book_service_opportunity for an item the customer clearly agreed to. Use the exact service_opportunity_id returned by get_service_opportunities.\n" +
        "- Never quote a firm price or promise a discount — estimates are approximate; the team confirms final pricing.\n" +
        "- Do not invent services beyond the list above.\n" +
        "- If the book_service_opportunity tool isn't available to you, still capture their interest and preferred date verbally — the team will complete the booking.\n" +
        "- Be warm and unhurried, but respect their time. Say goodbye only once every item has been addressed.",
    };
  }

  // Generic defaults for custom types
  return {
    begin_message:
      `Hi {{customer_name}}, this is {{representative_name}} calling from {{company_name}}. ` +
      `I'm reaching out regarding ${name.toLowerCase()} for your upcoming appointment on {{job_date}}. ` +
      `Is now a good time to talk?`,
    general_prompt:
      `You are {{representative_name}}, a professional assistant calling on behalf of {{company_name}}.\n\n` +
      `Purpose of this call: ${description}\n\n` +
      `When calling:\n` +
      `- Introduce yourself clearly\n` +
      `- State the purpose of the call concisely\n` +
      `- Be friendly, professional, and respectful of the customer's time\n` +
      `- If the customer is unavailable, offer to call back at a better time`,
  };
}

/**
 * Default voicemail messages per call type.
 * Supports {{representative_name}}, {{company_name}}, {{customer_name}}, {{technician_name}}.
 * These placeholders are resolved at call-creation time in the dispatcher.
 */
function generateDefaultVoicemailMessage(type) {
  switch (type) {
    case "customer_confirmation":
      return "Hi {{customer_name}}, this is {{representative_name}} from {{company_name}}. " +
             "We were calling to confirm your upcoming service appointment. " +
             "Please call us back at your earliest convenience. Thank you!";

    case "technician_confirmation":
      return "Hi {{technician_name}}, this is {{representative_name}} from {{company_name}}. " +
             "We were calling to confirm your availability for an upcoming job. " +
             "Please call us back when you get a chance. Thank you!";

    case "technician_reschedule":
      return "Hi {{technician_name}}, this is {{representative_name}} from {{company_name}}. " +
             "We need to discuss rescheduling one of your upcoming jobs. " +
             "Please call us back as soon as possible. Thank you!";

    case "quotation_followup":
      return "Hi {{customer_name}}, this is {{representative_name}} from {{company_name}}. " +
             "We were following up on a quote we recently sent you. " +
             "Please call us back when you have a moment. Thank you!";

    case "service_opportunity_followup":
      return "Hi {{customer_name}}, this is {{representative_name}} from {{company_name}}. " +
             "We were calling about some outstanding service items at {{location_name}} that we'd like to get scheduled. " +
             "Please call us back when you have a moment. Thank you!";

    default:
      return "Hi, this is {{representative_name}} from {{company_name}}. " +
             "We had a question for you and would love to connect. " +
             "Please call us back at your earliest convenience. Thank you!";
  }
}

/**
 * Generate a URL-safe slug from a display name.
 * e.g. "Post-job Follow-up" → "post_job_follow_up"
 */
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function rowToObject(row) {
  return {
    type:              row.type,
    name:              row.name,
    description:       row.description ?? "",
    is_custom:         row.is_custom,
    enabled:           row.enabled,
    begin_message:     row.begin_message ?? null,
    general_prompt:    row.general_prompt ?? null,
    voicemail_message: row.voicemail_message ?? generateDefaultVoicemailMessage(row.type),
  };
}

/**
 * Seed the three built-in rows for a new company (called during registration).
 * Uses a transaction client if provided, otherwise runs standalone.
 */
async function seedBuiltins(companyId, client) {
  const run = client ?? db;
  for (const seed of BUILTIN_SEEDS) {
    const { begin_message, general_prompt } = generateDefaultPrompts(seed.type, seed.name, seed.description);
    const voicemail_message = generateDefaultVoicemailMessage(seed.type);
    await run.query(
      `INSERT INTO call_type_configs
         (company_id, type, name, description, is_custom, enabled, begin_message, general_prompt, voicemail_message)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8)
       ON CONFLICT (company_id, type) DO NOTHING`,
      [companyId, seed.type, seed.name, seed.description, seed.enabled, begin_message, general_prompt, voicemail_message]
    );
  }
}

/**
 * Get all call type configs for a company (built-ins + custom).
 */
async function getAllByCompanyId(companyId) {
  const result = await db.query(
    `SELECT type, name, description, is_custom, enabled, begin_message, general_prompt, voicemail_message, retell_llm_id, retell_agent_id
     FROM call_type_configs
     WHERE company_id = $1
     ORDER BY is_custom ASC, created_at ASC`,
    [companyId]
  );
  return result.rows.map(rowToObject);
}

/**
 * Create a custom call type. Generates a unique slug from name.
 */
async function create(companyId, { name, description }) {
  const baseSlug = slugify(name);
  // Ensure uniqueness by appending suffix if slug already taken
  let slug = baseSlug;
  const existing = await db.query(
    `SELECT type FROM call_type_configs WHERE company_id = $1 AND type LIKE $2`,
    [companyId, `${baseSlug}%`]
  );
  if (existing.rows.some((r) => r.type === slug)) {
    slug = `${baseSlug}_${existing.rows.length + 1}`;
  }

  const { begin_message, general_prompt } = generateDefaultPrompts(slug, name, description ?? "");

  const result = await db.query(
    `INSERT INTO call_type_configs
       (company_id, type, name, description, is_custom, enabled, begin_message, general_prompt)
     VALUES ($1, $2, $3, $4, true, false, $5, $6)
     RETURNING type, name, description, is_custom, enabled, begin_message, general_prompt, voicemail_message, retell_llm_id, retell_agent_id`,
    [companyId, slug, name, description ?? "", begin_message, general_prompt]
  );
  return rowToObject(result.rows[0]);
}

/**
 * Get a single call type config by slug. Returns null if not found.
 */
async function getByType(companyId, type) {
  const result = await db.query(
    `SELECT type, name, description, is_custom, enabled, begin_message, general_prompt, voicemail_message, retell_llm_id, retell_agent_id
     FROM call_type_configs WHERE company_id = $1 AND type = $2`,
    [companyId, type]
  );
  return result.rows[0] ? rowToObject(result.rows[0]) : null;
}

/**
 * Partial update for any call type (built-in or custom).
 * For built-ins, `name` and `description` are ignored.
 */
async function upsert(companyId, type, fields) {
  const isBuiltin = BUILTIN_TYPES.includes(type);

  // For built-ins, always upsert (create if missing). For custom, only update existing.
  const allowed = ["enabled", "begin_message", "general_prompt", "voicemail_message"];
  if (!isBuiltin) allowed.push("name", "description");

  const provided = allowed.filter((k) => k in fields);
  if (provided.length === 0) return getByType(companyId, type);

  if (isBuiltin) {
    // Upsert built-in: insert with defaults if missing, then update provided fields below
    const seed = BUILTIN_SEEDS.find((s) => s.type === type);
    const { begin_message: defMsg, general_prompt: defPrompt } = generateDefaultPrompts(seed.type, seed.name, seed.description);
    await db.query(
      `INSERT INTO call_type_configs
         (company_id, type, name, description, is_custom, enabled, begin_message, general_prompt)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7)
       ON CONFLICT (company_id, type) DO NOTHING`,
      [companyId, type, seed.name, seed.description, seed.enabled, defMsg, defPrompt]
    );
  }

  const values = [companyId, type, ...provided.map((k) => fields[k])];
  const setClauses = provided.map((k, i) => `${k} = $${i + 3}`).join(", ");

  const result = await db.query(
    `UPDATE call_type_configs SET ${setClauses}, updated_at = NOW()
     WHERE company_id = $1 AND type = $2
     RETURNING type, name, description, is_custom, enabled, begin_message, general_prompt`,
    values
  );
  return result.rows[0] ? rowToObject(result.rows[0]) : null;
}

/**
 * Delete a custom call type. Returns { deleted: true } or throws if built-in/not found.
 */
async function remove(companyId, type) {
  if (BUILTIN_TYPES.includes(type)) {
    const err = new Error("Built-in call types cannot be deleted");
    err.status = 403;
    throw err;
  }
  const result = await db.query(
    `DELETE FROM call_type_configs WHERE company_id = $1 AND type = $2 AND is_custom = true RETURNING id`,
    [companyId, type]
  );
  if (result.rowCount === 0) {
    const err = new Error("Call type not found");
    err.status = 404;
    throw err;
  }
  return { deleted: true };
}

/**
 * Check if a name is already taken for this company (for uniqueness validation).
 */
async function nameExists(companyId, name, excludeType) {
  const result = await db.query(
    `SELECT 1 FROM call_type_configs WHERE company_id = $1 AND LOWER(name) = LOWER($2)${excludeType ? " AND type != $3" : ""}`,
    excludeType ? [companyId, name, excludeType] : [companyId, name]
  );
  return result.rowCount > 0;
}

module.exports = { BUILTIN_TYPES, BUILTIN_SEEDS, generateDefaultPrompts, generateDefaultVoicemailMessage, seedBuiltins, getAllByCompanyId, create, getByType, upsert, remove, nameExists };
