const { z } = require("zod");
const db = require("../../../../db");
const triggerConfigsDb = require("../../../../db/call-trigger-configs");

const schema = z.object({
  customer_id: z.union([z.string(), z.number()]).describe("The customer's id (resolve a name with find_customer first)."),
  include_past: z
    .boolean()
    .nullish()
    .describe(
      "Default false. When false (the normal case), only UPCOMING appointments/jobs are returned — past-due ones are excluded, since you don't schedule confirmation calls for dates that have already passed. Set true only if the user explicitly asks about past/overdue items."
    ),
});

/**
 * Discover what calls can be placed for a customer, and which reference to use.
 *
 * The job→appointment relationship is one-to-many, so the reference differs by
 * trigger:
 *   - scheduled_unconfirmed / technician_unconfirmed → a specific APPOINTMENT
 *   - open_job_due_soon                              → the JOB (no appointment)
 *   - quotation_pending                              → the QUOTATION
 *
 * Each candidate is annotated with whether its trigger is ENABLED in the
 * company's call_trigger_configs, so the copilot can ensure the trigger is
 * selected before calling (and offer to enable it if not).
 */
async function run({ customer_id, include_past }, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  const includePast = include_past === true;

  const cust = await db.query(
    `SELECT id, full_name FROM customers WHERE id = $1 AND company_id = $2`,
    [customer_id, companyId]
  );
  if (cust.rows.length === 0) return JSON.stringify({ status: "not_found", customer_id });

  // Enabled trigger types → call_type, plus the full set for enabled flags.
  const all = await triggerConfigsDb.getAllByCompanyId(companyId);
  const cfgByType = Object.fromEntries(all.map((t) => [t.trigger_type, t]));
  const isEnabled = (type) => !!cfgByType[type]?.enabled;
  const callTypeOf = (type) => cfgByType[type]?.call_type ?? null;

  const targets = [];

  // Appointments → customer/technician confirmation candidates.
  // Upcoming only by default: a confirmation call only makes sense for an
  // appointment whose start is still in the future.
  const appts = await db.query(
    `SELECT a.id AS appointment_id, a.scheduled_start, a.status,
            a.customer_confirmed, a.technician_confirmed, a.technician_id,
            j.id AS job_id, j.title AS job_title
     FROM appointments a
     JOIN jobs j ON j.id = a.job_id
     WHERE j.company_id = $1 AND j.customer_id = $2
       AND a.status NOT IN ('cancelled', 'completed', 'no_show')
       ${includePast ? "" : "AND a.scheduled_start >= NOW()"}
     ORDER BY a.scheduled_start ASC NULLS LAST`,
    [companyId, customer_id]
  );
  for (const a of appts.rows) {
    if (a.customer_confirmed !== true) {
      targets.push({
        trigger_type: "scheduled_unconfirmed",
        call_type: callTypeOf("scheduled_unconfirmed"),
        enabled: isEnabled("scheduled_unconfirmed"),
        reference_field: "appointment_id",
        reference_id: a.appointment_id,
        summary: { job_id: a.job_id, job_title: a.job_title, scheduled_start: a.scheduled_start, appointment_status: a.status },
      });
    }
    if (a.technician_id != null && a.technician_confirmed !== true) {
      targets.push({
        trigger_type: "technician_unconfirmed",
        call_type: callTypeOf("technician_unconfirmed"),
        enabled: isEnabled("technician_unconfirmed"),
        reference_field: "appointment_id",
        reference_id: a.appointment_id,
        summary: { job_id: a.job_id, job_title: a.job_title, scheduled_start: a.scheduled_start },
      });
    }
  }

  // Open (unscheduled) jobs → open_job_due_soon candidates (reference = job).
  // Upcoming only by default: exclude jobs whose expected date has already
  // passed (jobs with no date yet are still upcoming, so they're kept).
  const openJobs = await db.query(
    `SELECT id AS job_id, title, status, scheduled_date
     FROM jobs
     WHERE company_id = $1 AND customer_id = $2 AND status = 'open'
       ${includePast ? "" : "AND (scheduled_date >= CURRENT_DATE OR scheduled_date IS NULL)"}
     ORDER BY scheduled_date ASC NULLS LAST`,
    [companyId, customer_id]
  );
  for (const j of openJobs.rows) {
    targets.push({
      trigger_type: "open_job_due_soon",
      call_type: callTypeOf("open_job_due_soon"),
      enabled: isEnabled("open_job_due_soon"),
      reference_field: "job_id",
      reference_id: j.job_id,
      summary: { job_title: j.title, scheduled_date: j.scheduled_date, job_status: j.status },
    });
  }

  // Pending quotations → quotation_pending candidates.
  // Upcoming only by default: drop quotes whose validity date has passed.
  const quotes = await db.query(
    `SELECT id AS quotation_id, quote_number, status, total_amount, valid_until
     FROM quotations
     WHERE company_id = $1 AND customer_id = $2 AND status IN ('sent', 'viewed')
       ${includePast ? "" : "AND (valid_until IS NULL OR valid_until >= CURRENT_DATE)"}
     ORDER BY created_at DESC`,
    [companyId, customer_id]
  );
  for (const q of quotes.rows) {
    targets.push({
      trigger_type: "quotation_pending",
      call_type: callTypeOf("quotation_pending"),
      enabled: isEnabled("quotation_pending"),
      reference_field: "quotation_id",
      reference_id: q.quotation_id,
      summary: { quote_number: q.quote_number, status: q.status, total_amount: q.total_amount },
    });
  }

  const disabledButMatched = [
    ...new Set(targets.filter((t) => !t.enabled).map((t) => t.trigger_type)),
  ];

  return JSON.stringify({
    status: "ok",
    customer: { id: cust.rows[0].id, name: cust.rows[0].full_name },
    enabled_triggers: all.filter((t) => t.enabled).map((t) => t.trigger_type),
    targets,
    disabled_but_matched: disabledButMatched,
  });
}

module.exports = {
  name: "find_call_targets",
  description:
    "Given a customer, discover the calls that can be placed for them — UPCOMING appointments needing customer/technician confirmation, upcoming open jobs, and still-valid pending quotes (past-due/overdue items are excluded by default) — each with the exact reference to use (appointment_id, job_id, or quotation_id) and whether that trigger is ENABLED in configuration. Use this when the user asks to 'call this customer'. If multiple targets are returned, present them and let the user choose. If the matching trigger is disabled, tell the user (and offer set_call_trigger_enabled). Then call make_call / schedule_call with the chosen reference. Pass include_past=true only if the user explicitly wants past/overdue items.",
  isWrite: false,
  schema,
  run,
};
