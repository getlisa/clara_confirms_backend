const db = require("./index");

/**
 * Catalog of every {{dynamic_variable}} the platform recognizes.
 *
 * `resolved_from` is documentation only — it tells you which code path actually
 * fills the variable when a call is created. The dispatcher in
 * src/services/scheduler.js populates these values at call time.
 */
const VARIABLE_SEEDS = [
  // ── Routing ─────────────────────────────────────────────────────────────────
  { name: "call_type",           sort_order: 1,  resolved_from: "dispatcher.call_type",          description: "The slug of the call type (e.g. customer_confirmation, quotation_followup) — used by the branch router to pick the right subagent." },
  // Referenced throughout customer_confirmation's prompt but currently set by
  // nobody (the web-chat path is the LangGraph agent now, which doesn't use
  // Retell prompts at all). Registered so it resolves to "" — which reads as
  // "not a chat session", the correct branch — instead of rendering the
  // literal "{{is_chat_session}}" into the prompt on every voice call.
  { name: "is_chat_session",     sort_order: 2,  resolved_from: "unset — defaults to \"\" (voice)", description: "\"true\" only inside a Retell chat session; empty on a voice call, which is the branch every prompt should take." },

  // ── Company + agent identity (set on every call) ───────────────────────────
  { name: "company_name",        sort_order: 10, resolved_from: "default_dynamic_variables",     description: "The name of the company placing the call. Set once per company in the flow's default_dynamic_variables." },
  { name: "representative_name", sort_order: 11, resolved_from: "default_dynamic_variables",     description: "The friendly name the AI uses to introduce itself, e.g. 'Clara' or 'Sarah'." },

  // ── Date/time context ───────────────────────────────────────────────────────
  { name: "current_date",        sort_order: 20, resolved_from: "dispatcher (company timezone)", description: "The current date in the company's timezone, e.g. 'Wednesday, May 28, 2026'." },
  { name: "current_time",        sort_order: 21, resolved_from: "dispatcher (company timezone)", description: "The current time in the company's timezone, e.g. '02:45 PM'." },

  // ── Customer + technician details ───────────────────────────────────────────
  { name: "customer_name",       sort_order: 30, resolved_from: "scheduled_calls.customer_name",  description: "Customer's full name." },
  { name: "customer_address",    sort_order: 31, resolved_from: "scheduled_calls.customer_address", description: "Customer's address joined as a single string." },
  { name: "technician_name",     sort_order: 32, resolved_from: "scheduled_calls.technician_name", description: "Assigned technician's full name." },
  // Bound at dispatch from the confirmation RECIPIENT when the row has one (a
  // property manager etc.), else from the customer record — same resolution the
  // web_chat branch makes. Both are conditional, so both need a "" default: the
  // SERVICE LINK step reads {{customer_email}} directly.
  { name: "customer_email",      sort_order: 33, resolved_from: "dispatcher (recipient snapshot, else customers.email, live at dispatch)", description: "Email already on file for whoever this call is with — presented for confirmation in the service-link step instead of asking blind. Blank when none is on file, which is the prompt's cue to ask." },
  { name: "customer_phone",      sort_order: 34, resolved_from: "dispatcher (recipient snapshot, else customers.phone, live at dispatch)", description: "Phone already on file for whoever this call is with. Blank when none is on file." },

  // ── Job context ─────────────────────────────────────────────────────────────
  { name: "job_id",              sort_order: 40, resolved_from: "scheduled_calls.job_id",         description: "Numeric job ID (or 'quotation:N' for quotation calls). Required by all tools." },
  { name: "job_name",            sort_order: 41, resolved_from: "scheduled_calls.job_name",       description: "Human-readable job title, e.g. 'AC Unit Repair'." },
  { name: "job_description",     sort_order: 42, resolved_from: "scheduled_calls.job_description", description: "What the job entails — used to answer customer questions." },
  { name: "job_type",            sort_order: 43, resolved_from: "scheduled_calls.job_type",       description: "Category of work, e.g. 'inspection', 'repair', 'maintenance'." },
  { name: "job_date",            sort_order: 44, resolved_from: "scheduled_calls.job_date",       description: "Formatted job date, e.g. 'Thursday, May 28, 2026'." },
  { name: "job_number",          sort_order: 45, resolved_from: "job-confirmation-context (job details, live at dispatch)", description: "The CRM's own job number, e.g. '48767205' — what a customer would quote back to you. Falls back to the internal job id when the CRM has none." },
  { name: "job_comments",        sort_order: 46, resolved_from: "job-confirmation-context (job details, live at dispatch)", description: "Scheduling comments the team left on the job, most recent first, joined with ' | '. 'none' when there are none." },

  // ── Appointment + quotation ─────────────────────────────────────────────────
  // Appointment data IS now injected for customer_confirmation — reversing the
  // earlier rule that it never should be. The reason it was banned was
  // staleness: Retell binds variables once at call creation, "a queued row can
  // sit for days, and appointments change mid-conversation".
  //
  // Half of that no longer applies: the dispatcher computes the job context
  // FRESH at dispatch (services/scheduler.js — "Computed HERE, at dispatch,
  // not when the row was queued"), seconds before the call connects. The other
  // half still does — appointments really can change mid-call — so these are
  // scoped to the OPENING only: customer_confirmation's prompt requires a
  // get_appointments call after any confirm/reschedule/cancel/create, and
  // falls back to the tool when these arrive blank.
  //
  // The point is latency: without them the agent cannot say anything about the
  // visit until a tool round-trip completes, which is why it had to stall with
  // "Let me pull up the appointments on this job."
  { name: "appointment_id",      sort_order: 50, resolved_from: "scheduled_calls.appointment_id", description: "The appointment this call was queued for. Used by technician_confirmation, which is appointment-specific. customer_confirmation uses next_appointment_id / upcoming_appointments instead." },
  { name: "upcoming_count",         sort_order: 51, resolved_from: "job-confirmation-context (live at dispatch)", description: "How many upcoming appointments are on this job. Blank when the job context could not be built — the agent then falls back to the get_appointments tool." },
  { name: "unconfirmed_count",      sort_order: 52, resolved_from: "job-confirmation-context (live at dispatch)", description: "How many of the upcoming appointments the customer has not confirmed yet." },
  { name: "all_upcoming_confirmed", sort_order: 53, resolved_from: "job-confirmation-context (live at dispatch)", description: "'true' when every upcoming appointment is already confirmed, else 'false'." },
  { name: "next_appointment_id",    sort_order: 54, resolved_from: "job-confirmation-context (live at dispatch)", description: "Appointment ID of the next upcoming visit — what confirm_appointment is called with when the customer confirms it." },
  // These two carry the highest stakes of the whole set: they are interpolated
  // into begin_message, the first thing said when the call connects, before any
  // prompt logic or tool call can compensate. The dispatcher only sets them
  // when the job HAS a next appointment, so a job with none (or a job context
  // that failed to build) would otherwise open by speaking the literal text
  // "{{next_service_line}}" at the customer. Registered = they resolve to "",
  // and the prompt's "if these are empty, drop that clause" rule takes over.
  { name: "next_appointment_date",  sort_order: 55, resolved_from: "job-confirmation-context (live at dispatch)", description: "Spoken date/time of the next upcoming visit, e.g. 'Thursday, May 28, 2026 at 10:00 AM'. Blank when no visit is booked — the opening line drops the clause that uses it." },
  { name: "next_service_line",      sort_order: 56, resolved_from: "job-confirmation-context (live at dispatch)", description: "Service line of the next upcoming visit, falling back to the job title. Blank when no visit is booked — the opening line drops the clause that uses it." },
  { name: "next_technician",        sort_order: 57, resolved_from: "job-confirmation-context (live at dispatch)", description: "Technician assigned to the next upcoming visit. Blank when none is assigned." },
  { name: "upcoming_appointments",  sort_order: 58, resolved_from: "job-confirmation-context (live at dispatch)", description: "Pre-rendered list of the job's upcoming appointments, one per line (id, date, service line, technician, confirmed state). Capped at 8 with a '...plus N more' tail — the agent calls get_appointments to see beyond that." },
  { name: "total_amount",        sort_order: 60, resolved_from: "scheduled_calls.total_amount",   description: "Quotation total amount (string) — used in quotation_followup calls." },

  // ── Service opportunity follow-up ─────────────────────────────────────────────
  { name: "location_name",           sort_order: 70, resolved_from: "scheduled_calls.call_context", description: "The location (site) the service opportunities belong to — used in service_opportunity_followup calls." },
  { name: "location_address",        sort_order: 71, resolved_from: "scheduled_calls.call_context", description: "The location's address, joined as one string." },
  { name: "primary_contact_name",    sort_order: 72, resolved_from: "scheduled_calls.call_context", description: "The site's primary contact name — who the agent can ask for on a service_opportunity_followup call." },
  { name: "general_manager_name",    sort_order: 73, resolved_from: "scheduled_calls.call_context", description: "The site's general manager name (alternate contact) for service_opportunity_followup calls." },
  { name: "service_opportunity_count", sort_order: 74, resolved_from: "scheduled_calls.call_context", description: "How many open service opportunities this call covers (used in the opening). The detailed list is fetched by the agent via the get_service_opportunities tool, not a variable." },
];

async function seedAll() {
  for (const v of VARIABLE_SEEDS) {
    await db.query(
      `INSERT INTO dynamic_variable_definitions (name, description, default_value, resolved_from, sort_order)
       VALUES ($1, $2, '', $3, $4)
       ON CONFLICT (name) DO UPDATE SET
         description   = EXCLUDED.description,
         resolved_from = EXCLUDED.resolved_from,
         sort_order    = EXCLUDED.sort_order,
         updated_at    = NOW()`,
      [v.name, v.description, v.resolved_from ?? null, v.sort_order]
    );
  }
}

async function getEnabled() {
  const { rows } = await db.query(
    `SELECT name, default_value FROM dynamic_variable_definitions
     WHERE enabled = true ORDER BY sort_order ASC`
  );
  return rows;
}

async function getAll() {
  const { rows } = await db.query(
    `SELECT name, description, default_value, resolved_from, enabled, sort_order, updated_at
     FROM dynamic_variable_definitions ORDER BY sort_order ASC`
  );
  return rows;
}

/**
 * Build the object passed to Retell as `default_dynamic_variables`.
 * Merges DB-driven catalog with the company-specific overrides (company_name, rep name).
 */
async function buildDefaultsForCompany({ companyName, representativeName } = {}) {
  const vars = await getEnabled();
  const result = {};
  for (const v of vars) {
    result[v.name] = v.default_value || "";
  }
  if (companyName)        result.company_name        = companyName;
  if (representativeName) result.representative_name = representativeName;
  return result;
}

module.exports = { VARIABLE_SEEDS, seedAll, getEnabled, getAll, buildDefaultsForCompany };
