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

  // ── Job context ─────────────────────────────────────────────────────────────
  { name: "job_id",              sort_order: 40, resolved_from: "scheduled_calls.job_id",         description: "Numeric job ID (or 'quotation:N' for quotation calls). Required by all tools." },
  { name: "job_name",            sort_order: 41, resolved_from: "scheduled_calls.job_name",       description: "Human-readable job title, e.g. 'AC Unit Repair'." },
  { name: "job_description",     sort_order: 42, resolved_from: "scheduled_calls.job_description", description: "What the job entails — used to answer customer questions." },
  { name: "job_type",            sort_order: 43, resolved_from: "scheduled_calls.job_type",       description: "Category of work, e.g. 'inspection', 'repair', 'maintenance'." },
  { name: "job_date",            sort_order: 44, resolved_from: "scheduled_calls.job_date",       description: "Formatted job date, e.g. 'Thursday, May 28, 2026'." },

  // ── Appointment + quotation ─────────────────────────────────────────────────
  { name: "appointment_id",      sort_order: 50, resolved_from: "scheduled_calls.appointment_id", description: "Numeric appointment ID for confirm/reschedule tools." },
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
