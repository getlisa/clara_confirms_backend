const db = require("./index");

const BUILTIN_TYPES = ["customer_confirmation", "technician_confirmation", "technician_reschedule"];

const BUILTIN_SEEDS = [
  {
    type: "customer_confirmation",
    name: "Customer Confirmation",
    description: "Call the end customer to confirm their upcoming appointment.",
    enabled: true,
    days_before: 2,
  },
  {
    type: "technician_confirmation",
    name: "Technician Confirmation",
    description: "Call the assigned technician to confirm availability for the job.",
    enabled: true,
    days_before: 1,
  },
  {
    type: "technician_reschedule",
    name: "Technician Reschedule Notice",
    description: "Notify the technician that their job needs to be rescheduled.",
    enabled: false,
    days_before: 1,
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
        "I'm reaching out to confirm your upcoming service appointment on {{job_date}}. " +
        "Is now a good time to talk?",
      general_prompt:
        "You are {{representative_name}}, a friendly and professional scheduling assistant " +
        "calling on behalf of {{company_name}}. Your goal is to confirm the customer's " +
        "upcoming service appointment (Job #{{job_id}}) scheduled for {{job_date}}.\n\n" +
        "When calling:\n" +
        "- Greet the customer warmly and introduce yourself\n" +
        "- Confirm the appointment date and time\n" +
        "- Ask if they have any questions or need to reschedule\n" +
        "- If they want to reschedule, collect their preferred time and let them know someone will follow up\n" +
        "- Be concise, polite, and professional throughout\n" +
        "- Do not discuss pricing, contracts, or anything outside of appointment confirmation",
    };
  }

  if (type === "technician_confirmation") {
    return {
      begin_message:
        "Hi {{technician_name}}, this is {{representative_name}} from {{company_name}}. " +
        "I'm calling to confirm you're available for a job on {{job_date}} at {{customer_address}}. " +
        "Do you have a moment?",
      general_prompt:
        "You are {{representative_name}}, a scheduling coordinator calling on behalf of {{company_name}}. " +
        "Your goal is to confirm the technician's availability for Job #{{job_id}} " +
        "scheduled on {{job_date}} at {{customer_address}}.\n\n" +
        "When calling:\n" +
        "- Confirm the job date, time, and location\n" +
        "- Ask if they have any conflicts or concerns\n" +
        "- If they are unavailable, collect their availability and let them know a coordinator will follow up\n" +
        "- Be professional and concise",
    };
  }

  if (type === "technician_reschedule") {
    return {
      begin_message:
        "Hi {{technician_name}}, this is {{representative_name}} from {{company_name}}. " +
        "I'm calling regarding Job #{{job_id}} at {{customer_address}} on {{job_date}} — " +
        "we need to discuss rescheduling. Do you have a moment?",
      general_prompt:
        "You are {{representative_name}}, a scheduling coordinator calling on behalf of {{company_name}}. " +
        "The purpose of this call is to notify the technician that Job #{{job_id}} " +
        "scheduled on {{job_date}} at {{customer_address}} needs to be rescheduled.\n\n" +
        "When calling:\n" +
        "- Explain that the job needs to be rescheduled\n" +
        "- Collect the technician's availability for an alternative time\n" +
        "- Be professional and empathetic\n" +
        "- Confirm that a coordinator will follow up with the new schedule",
    };
  }

  // Generic defaults for custom types — derived from name and description
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
    type:           row.type,
    name:           row.name,
    description:    row.description ?? "",
    is_custom:      row.is_custom,
    enabled:        row.enabled,
    days_before:    Number(row.days_before),
    begin_message:  row.begin_message ?? null,
    general_prompt: row.general_prompt ?? null,
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
    await run.query(
      `INSERT INTO call_type_configs
         (company_id, type, name, description, is_custom, enabled, days_before, begin_message, general_prompt)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8)
       ON CONFLICT (company_id, type) DO NOTHING`,
      [companyId, seed.type, seed.name, seed.description, seed.enabled, seed.days_before, begin_message, general_prompt]
    );
  }
}

/**
 * Get all call type configs for a company (built-ins + custom).
 */
async function getAllByCompanyId(companyId) {
  const result = await db.query(
    `SELECT type, name, description, is_custom, enabled, days_before, begin_message, general_prompt, retell_llm_id, retell_agent_id
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
async function create(companyId, { name, description, days_before }) {
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
       (company_id, type, name, description, is_custom, enabled, days_before, begin_message, general_prompt)
     VALUES ($1, $2, $3, $4, true, false, $5, $6, $7)
     RETURNING type, name, description, is_custom, enabled, days_before, begin_message, general_prompt, retell_llm_id, retell_agent_id`,
    [companyId, slug, name, description ?? "", days_before ?? 2, begin_message, general_prompt]
  );
  return rowToObject(result.rows[0]);
}

/**
 * Get a single call type config by slug. Returns null if not found.
 */
async function getByType(companyId, type) {
  const result = await db.query(
    `SELECT type, name, description, is_custom, enabled, days_before, begin_message, general_prompt, retell_llm_id, retell_agent_id
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
  const allowed = ["enabled", "days_before", "begin_message", "general_prompt"];
  if (!isBuiltin) allowed.push("name", "description");

  const provided = allowed.filter((k) => k in fields);
  if (provided.length === 0) return getByType(companyId, type);

  if (isBuiltin) {
    // Upsert built-in: insert with defaults if missing, then update provided fields below
    const seed = BUILTIN_SEEDS.find((s) => s.type === type);
    const { begin_message: defMsg, general_prompt: defPrompt } = generateDefaultPrompts(seed.type, seed.name, seed.description);
    await db.query(
      `INSERT INTO call_type_configs
         (company_id, type, name, description, is_custom, enabled, days_before, begin_message, general_prompt)
       VALUES ($1, $2, $3, $4, false, $5, $6, $7, $8)
       ON CONFLICT (company_id, type) DO NOTHING`,
      [companyId, type, seed.name, seed.description, seed.enabled, seed.days_before, defMsg, defPrompt]
    );
  }

  const values = [companyId, type, ...provided.map((k) => fields[k])];
  const setClauses = provided.map((k, i) => `${k} = $${i + 3}`).join(", ");

  const result = await db.query(
    `UPDATE call_type_configs SET ${setClauses}, updated_at = NOW()
     WHERE company_id = $1 AND type = $2
     RETURNING type, name, description, is_custom, enabled, days_before, begin_message, general_prompt`,
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

module.exports = { BUILTIN_TYPES, seedBuiltins, getAllByCompanyId, create, getByType, upsert, remove, nameExists };
