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
    name: "search_contact",
    description: "Search ServiceTrade for an existing contact to email the service link to — by name, phone, or email. Use this BEFORE creating a new contact. Returns matching contacts with their contact_id so you can confirm the right person with the customer.",
    endpoint: "/retell/tools/search_contact",
    speak_during_execution: true,
    speak_after_execution: false,
    execution_message_description: "Let me look that contact up.",
    is_write_tool: false,
    gated_by_setting: "service_link_enabled",
    sort_order: 20,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name, phone number, or email to search for." },
      },
      required: ["query"],
    },
  },
  {
    call_type: "customer_confirmation",
    name: "create_contact",
    description: "Record who should receive the service link by email (the link is emailed automatically after the call). If you confirmed an EXISTING contact via search_contact, pass existing_contact_id plus the confirmed email. Otherwise provide first_name, last_name, email, and the customer's role (e.g. 'management', 'billing', 'on-site') so a NEW contact is created.",
    endpoint: "/retell/tools/create_contact",
    speak_during_execution: true,
    speak_after_execution: true,
    execution_message_description: "Let me set that up.",
    is_write_tool: true,
    gated_by_setting: "service_link_enabled",
    sort_order: 21,
    parameters: {
      type: "object",
      properties: {
        email: { type: "string", description: "The confirmed email address to send the service link to. Required." },
        existing_contact_id: { type: "string", description: "If you confirmed an existing contact from search_contact, pass its contact_id here. Omit when creating a new contact." },
        first_name: { type: "string", description: "First name (when creating a new contact)." },
        last_name: { type: "string", description: "Last name (when creating a new contact)." },
        phone: { type: "string", description: "Phone number (optional, when creating a new contact)." },
        role: { type: "string", description: "The contact's role/type as stated by the customer, e.g. 'management', 'billing', 'on-site' (when creating a new contact)." },
      },
      required: ["email"],
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
  {
    call_type: "customer_confirmation",
    name: "cancel_appointment",
    description: "Cancel the appointment when the customer explicitly wants to cancel outright (not reschedule). Before calling this you MUST ask the customer two things: (1) do they want to cancel just this appointment, or the entire job because they no longer need the service at all, and (2) the reason for cancelling.",
    endpoint: "/retell/tools/cancel_appointment",
    speak_during_execution: true,
    speak_after_execution: true,
    execution_message_description: "Let me take care of that cancellation.",
    is_write_tool: true,
    sort_order: 7,
    parameters: {
      type: "object",
      properties: {
        appointment_id: { type: "string", description: "The appointment ID for this call. You were given this value at the start of the call — use that exact numeric ID." },
        scope: { type: "string", enum: ["appointment_only", "entire_job"], description: "Whether the customer wants to cancel just this appointment or the entire job. You must ask this explicitly before calling the tool." },
        reason: { type: "string", description: "The reason the customer gave for cancelling." },
      },
      required: ["appointment_id", "scope", "reason"],
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

  {
    call_type: "service_opportunity_followup",
    name: "get_service_opportunities",
    description: "Fetch the open service opportunities this call is about — each item's ID, the work, why it's recommended (inspection deficiency), estimated price, whether it's a recurring service, and the requested window. Call this first, at the start of the call, to know what to discuss. Takes no arguments — it returns the items for the current call.",
    endpoint: "/retell/tools/get_service_opportunities",
    speak_during_execution: true,
    speak_after_execution: false,
    execution_message_description: "Let me pull up the details.",
    is_write_tool: false,
    sort_order: 0,
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    call_type: "service_opportunity_followup",
    name: "book_service_opportunity",
    description: "Book a service opportunity in the platform once the customer has agreed to have that work scheduled. Call this per service opportunity the customer accepts, using the exact service_opportunity_id from the list you were given at the start of the call.",
    endpoint: "/retell/tools/book_service_opportunity",
    speak_during_execution: true,
    speak_after_execution: false,
    execution_message_description: "Let me get that noted for you.",
    is_write_tool: true,
    sort_order: 1,
    parameters: {
      type: "object",
      properties: {
        service_opportunity_id: { type: "string", description: "The numeric ID of the specific service opportunity the customer agreed to book. Use the exact ID from the list provided at the start of the call." },
        preferred_date:         { type: "string", description: "Optional. The date/time the customer prefers for this work, e.g. 'next Tuesday morning', '2026-08-16'." },
        notes:                  { type: "string", description: "Optional. Any details or constraints the customer mentioned about this item." },
      },
      required: ["service_opportunity_id"],
    },
  },

  // ── Universal tools (attached to every call_type's subagent node) ───────────
  // Sentinel call_type '_universal' — `registerToolsForCompany` merges these
  // into every node's tool list so the agent always has them available
  // regardless of the call's type (built-in or custom).
  {
    call_type: "_universal",
    name: "schedule_callback",
    description: "Use when the customer or technician asks to be called back at a specific time. Confirm the time with them first, then call this tool. After it returns, tell them the confirmed callback time. Works for any call type — confirmations, quote follow-ups, technician calls, custom call types.",
    endpoint: "/retell/tools/schedule_callback",
    speak_during_execution: false,
    speak_after_execution: true,
    // Not marked as a write tool — queuing a follow-up call doesn't mutate
    // customer-facing records (the parent call exists, the callback just creates
    // a new pending call). Available even when agent_can_make_changes=false so
    // read-only agents can still honor a "call me back" request.
    is_write_tool: false,
    sort_order: 99,
    parameters: {
      type: "object",
      properties: {
        callback_time: { type: "string", description: "When to call back. Accepts: ISO 8601 (e.g. '2026-06-15T16:00:00'), 12-hour clock ('4pm', '2:30 PM'), 24-hour clock ('14:00'), or a relative duration ('in 30 minutes', 'in an hour'). Times without a date refer to today in the caller's local time." },
        reason:        { type: "string", description: "Optional. A short note about what they want to discuss when called back." },
      },
      required: ["callback_time"],
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
          gated_by_setting, sort_order, parameters)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (call_type, name) DO UPDATE SET
         description                   = EXCLUDED.description,
         endpoint                      = EXCLUDED.endpoint,
         speak_during_execution        = EXCLUDED.speak_during_execution,
         speak_after_execution         = EXCLUDED.speak_after_execution,
         execution_message_description = EXCLUDED.execution_message_description,
         is_write_tool                 = EXCLUDED.is_write_tool,
         gated_by_setting              = EXCLUDED.gated_by_setting,
         sort_order                    = EXCLUDED.sort_order,
         parameters                    = EXCLUDED.parameters,
         updated_at                    = NOW()`,
      [
        t.call_type, t.name, t.description, t.endpoint,
        t.speak_during_execution, t.speak_after_execution,
        t.execution_message_description ?? null, t.is_write_tool,
        t.gated_by_setting ?? null,
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
