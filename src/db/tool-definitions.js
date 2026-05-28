const db = require("./index");

// ── Seed data ─────────────────────────────────────────────────────────────────
// endpoint: path only — URL = baseUrl + endpoint + ?company_id=X at registration time
// is_write_tool: filtered out when agent_can_make_changes = false

const TOOL_SEEDS = [
  // ── customer_confirmation ───────────────────────────────────────────────────
  {
    call_type: "customer_confirmation",
    name: "get_job",
    description: "Retrieve full details of the job this call is about — status, scheduled date, existing appointments, and whether an active appointment exists.",
    endpoint: "/retell/tools/get_job",
    speak_during_execution: true,
    speak_after_execution: false,
    execution_message_description: "Let me pull up the job details.",
    is_write_tool: false,
    sort_order: 1,
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job ID for this call. You were given this value at the start of the call — use that exact numeric ID." },
      },
      required: ["job_id"],
    },
  },
  {
    call_type: "customer_confirmation",
    name: "get_appointment",
    description: "Retrieve details of a specific appointment — scheduled time, confirmation status, assigned technician.",
    endpoint: "/retell/tools/get_appointment",
    speak_during_execution: true,
    speak_after_execution: false,
    execution_message_description: "Let me check the appointment details.",
    is_write_tool: false,
    sort_order: 2,
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "The appointment ID for this call. You were given this value at the start of the call — use that exact numeric ID." },
      },
      required: ["appointment_id"],
    },
  },
  {
    call_type: "customer_confirmation",
    name: "confirm_appointment",
    description: "Mark the customer as confirmed for their appointment. Call this when the customer verbally confirms they will attend.",
    endpoint: "/retell/tools/confirm_appointment",
    speak_during_execution: false,
    speak_after_execution: true,
    is_write_tool: true,
    sort_order: 3,
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "The appointment ID for this call. You were given this value at the start of the call — use that exact numeric ID." },
      },
      required: ["appointment_id"],
    },
  },
  {
    call_type: "customer_confirmation",
    name: "reschedule_appointment",
    description: "Update the scheduled time of an existing appointment when the customer requests a different time.",
    endpoint: "/retell/tools/reschedule_appointment",
    speak_during_execution: true,
    speak_after_execution: true,
    execution_message_description: "Let me update that appointment time.",
    is_write_tool: true,
    sort_order: 4,
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "The appointment ID for this call. You were given this value at the start of the call — use that exact numeric ID." },
        scheduled_start: { type: "string", description: "New start datetime in ISO 8601 format, e.g. 2026-05-28T10:00:00." },
        scheduled_end:   { type: "string", description: "New end datetime in ISO 8601 format (optional — defaults to 2 hours after start)." },
      },
      required: ["appointment_id", "scheduled_start"],
    },
  },
  {
    call_type: "customer_confirmation",
    name: "reschedule_job",
    description: "Update the scheduled date of the job itself when the customer wants to move the job to a different day entirely.",
    endpoint: "/retell/tools/reschedule_job",
    speak_during_execution: true,
    speak_after_execution: true,
    execution_message_description: "Let me update the job date for you.",
    is_write_tool: true,
    sort_order: 5,
    parameters: {
      type: "object",
      properties: {
        job_id:             { type: "string", description: "The job ID for this call. Use the exact numeric ID you were given at the start of the call." },
        new_scheduled_date: { type: "string", description: "The new date for the job in YYYY-MM-DD format, e.g. 2026-06-05." },
      },
      required: ["job_id", "new_scheduled_date"],
    },
  },
  {
    call_type: "customer_confirmation",
    name: "create_appointment",
    description: "Create a new appointment for this job when the customer wants to book a time slot and no appointment exists yet.",
    endpoint: "/retell/tools/create_appointment",
    speak_during_execution: true,
    speak_after_execution: false,
    execution_message_description: "I'll book that appointment now.",
    is_write_tool: true,
    sort_order: 6,
    parameters: {
      type: "object",
      properties: {
        job_id:          { type: "string", description: "The job ID to create an appointment for." },
        scheduled_start: { type: "string", description: "Appointment start datetime in ISO 8601 format, in the customer's local time." },
        scheduled_end:   { type: "string", description: "Appointment end datetime in ISO 8601 format (optional — defaults to 2 hours after start)." },
      },
      required: ["job_id", "scheduled_start"],
    },
  },

  // ── technician_confirmation ─────────────────────────────────────────────────
  {
    call_type: "technician_confirmation",
    name: "get_job",
    description: "Retrieve the job details for this appointment — customer name, address, scheduled date, and job description.",
    endpoint: "/retell/tools/get_job",
    speak_during_execution: true,
    speak_after_execution: false,
    execution_message_description: "Let me pull up the job details.",
    is_write_tool: false,
    sort_order: 1,
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job ID for this call. You were given this value at the start of the call — use that exact numeric ID." },
      },
      required: ["job_id"],
    },
  },
  {
    call_type: "technician_confirmation",
    name: "confirm_appointment",
    description: "Mark the technician as confirmed for this appointment. Call this when the technician verbally confirms availability.",
    endpoint: "/retell/tools/confirm_appointment_technician",
    speak_during_execution: false,
    speak_after_execution: true,
    is_write_tool: true,
    sort_order: 2,
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "The appointment ID for this call. You were given this value at the start of the call — use that exact numeric ID." },
      },
      required: ["appointment_id"],
    },
  },

  // ── quotation_followup ──────────────────────────────────────────────────────
  {
    call_type: "quotation_followup",
    name: "get_quotation",
    description: "Retrieve the quotation this follow-up is about — title, total amount, status, line items, and validity date.",
    endpoint: "/retell/tools/get_quotation",
    speak_during_execution: true,
    speak_after_execution: false,
    execution_message_description: "Let me pull up the quote details.",
    is_write_tool: false,
    sort_order: 1,
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job ID for this call. You were given this value at the start of the call — use that exact numeric ID." },
      },
      required: ["job_id"],
    },
  },
];

// ── DB functions ──────────────────────────────────────────────────────────────

async function seedAll() {
  for (const t of TOOL_SEEDS) {
    await db.query(
      `INSERT INTO tool_definitions
         (call_type, name, description, endpoint, speak_during_execution,
          speak_after_execution, execution_message_description, is_write_tool,
          sort_order, parameters)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (call_type, name) DO UPDATE SET
         description                   = EXCLUDED.description,
         endpoint                      = EXCLUDED.endpoint,
         speak_during_execution        = EXCLUDED.speak_during_execution,
         speak_after_execution         = EXCLUDED.speak_after_execution,
         execution_message_description = EXCLUDED.execution_message_description,
         is_write_tool                 = EXCLUDED.is_write_tool,
         sort_order                    = EXCLUDED.sort_order,
         parameters                    = EXCLUDED.parameters,
         updated_at                    = NOW()`,
      [
        t.call_type, t.name, t.description, t.endpoint,
        t.speak_during_execution, t.speak_after_execution,
        t.execution_message_description ?? null, t.is_write_tool,
        t.sort_order, JSON.stringify(t.parameters ?? {}),
      ]
    );
  }
}

async function getForCallType(callType, { writeToolsEnabled = true } = {}) {
  const result = await db.query(
    `SELECT * FROM tool_definitions
     WHERE call_type = $1
       AND enabled = true
       ${!writeToolsEnabled ? "AND is_write_tool = false" : ""}
     ORDER BY sort_order ASC`,
    [callType]
  );
  return result.rows;
}

async function getAll({ writeToolsEnabled = true } = {}) {
  const result = await db.query(
    `SELECT * FROM tool_definitions
     WHERE enabled = true
       ${!writeToolsEnabled ? "AND is_write_tool = false" : ""}
     ORDER BY call_type, sort_order ASC`
  );
  return result.rows;
}

module.exports = { TOOL_SEEDS, seedAll, getForCallType, getAll };
