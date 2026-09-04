/**
 * Per-call-type hydrators for the manual-call API.
 *
 * Each function takes (companyId, targetId) and returns either:
 *   { ok: true, jobId, params }              — params is the exact dict to
 *                                              pass to scheduledCallsDb.create()
 *                                              (minus scheduledAt/isTest/maxAttempts).
 *   { ok: false, status: 404 }               — target not found for this company.
 *   { ok: false, status: 422, error: "..." } — found but not callable (cancelled,
 *                                              in the past, closed, no technician).
 *
 * A missing phone number is NOT rejected here — hydrators return the context with
 * params.phoneNumber possibly null, plus phoneSubject ("customer"|"technician").
 * manual-call.js decides the final number (manual override wins) and enforces
 * presence, so a caller can supply a phone_number to dial a target with no number.
 *
 * Mirrors the JOINs in src/services/scheduler.js's four process* functions
 * but filtered to a single target_id so a UI button can place exactly one call.
 */

const db = require("./../db");
const scheduledCallsDb = require("../db/scheduled-calls");
const { toLocalDateOnly } = require("../utils/timezone");

function joinAddress(row) {
  return [row.address_line1, row.city, row.state].filter(Boolean).join(", ") || null;
}

// ── scheduled_unconfirmed (customer) — by appointment_id ────────────────────
async function hydrateScheduledUnconfirmed(companyId, appointmentId) {
  const { rows } = await db.query(
    `SELECT a.id AS appointment_id, a.scheduled_start, a.status AS appointment_status,
            j.id AS job_id, j.scheduled_date, j.status AS job_status,
            j.title AS job_name, j.description AS job_description, j.job_type,
            -- InspectPoint Accounts carry NO phone or email at all (verified:
            -- null on every job of a real tenant), so the site's own number is
            -- the only one to call about a visit there. Falling back at read
            -- time rather than copying it onto the customer record keeps the
            -- two entities honest -- a building phone is not the customer's.
            COALESCE(c.phone, l.phone) AS customer_phone,
            COALESCE(c.full_name, l.name) AS customer_name,
            c.address_line1, c.city, c.state
       FROM appointments a
       JOIN jobs j      ON j.id = a.job_id
       LEFT JOIN locations l ON l.id = j.location_id
       -- LEFT: a job need not have a customer (InspectPoint links work to a
       -- BUILDING; its Account is optional and usually absent). An inner join
       -- made this report "not found" for a row that plainly exists, hiding
       -- the real problem. Missing contact details are caught downstream by
       -- the missing_phone gate, which says so accurately.
       LEFT JOIN customers c ON c.id = j.customer_id
      WHERE a.id = $1 AND j.company_id = $2
      LIMIT 1`,
    [appointmentId, companyId]
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "Appointment not found" };
  if (row.appointment_status === "cancelled") {
    return { ok: false, status: 422, code: "appointment_cancelled", error: "Appointment is cancelled" };
  }
  if (row.scheduled_start && new Date(row.scheduled_start) < new Date()) {
    return { ok: false, status: 422, code: "appointment_in_past", error: "Appointment scheduled time has already passed" };
  }
  // Phone may be absent here — enforcement (and manual-number override) happens
  // in manual-call.js so a caller can supply a phone_number to dial.
  const jobId = String(row.job_id);
  return {
    ok: true,
    jobId,
    phoneSubject: "customer",
    callType: "scheduled_unconfirmed",
    params: {
      callType:        "scheduled_unconfirmed",
      phoneNumber:     row.customer_phone || null,
      jobId,
      jobDate:         row.scheduled_start || row.scheduled_date || null,
      appointmentId:   row.appointment_id,
      customerName:    row.customer_name,
      customerAddress: joinAddress(row),
      jobName:         row.job_name || null,
      jobDescription:  row.job_description || null,
      jobType:         row.job_type || null,
    },
  };
}

// ── technician_unconfirmed (technician) — by appointment_id ─────────────────
async function hydrateTechnicianUnconfirmed(companyId, appointmentId) {
  const { rows } = await db.query(
    `SELECT a.id AS appointment_id, a.scheduled_start, a.status AS appointment_status, a.technician_id,
            j.id AS job_id, j.scheduled_date,
            j.title AS job_name, j.description AS job_description, j.job_type,
            t.phone AS technician_phone, t.first_name || ' ' || t.last_name AS technician_name,
            t.is_active AS technician_active,
            c.full_name AS customer_name,
            c.address_line1, c.city, c.state
       FROM appointments a
       JOIN jobs j        ON j.id = a.job_id
       LEFT JOIN technicians t ON t.id = a.technician_id
       JOIN customers c   ON c.id = j.customer_id
      WHERE a.id = $1 AND j.company_id = $2
      LIMIT 1`,
    [appointmentId, companyId]
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "Appointment not found" };
  if (row.appointment_status === "cancelled") {
    return { ok: false, status: 422, code: "appointment_cancelled", error: "Appointment is cancelled" };
  }
  if (row.scheduled_start && new Date(row.scheduled_start) < new Date()) {
    return { ok: false, status: 422, code: "appointment_in_past", error: "Appointment scheduled time has already passed" };
  }
  if (!row.technician_id) {
    return { ok: false, status: 422, code: "no_technician", error: "No technician assigned to this appointment", subject: "technician" };
  }
  // Phone may be absent — enforced/overridable in manual-call.js.
  const jobId = String(row.job_id);
  return {
    ok: true,
    jobId,
    phoneSubject: "technician",
    callType: "technician_unconfirmed",
    params: {
      callType:        "technician_unconfirmed",
      phoneNumber:     row.technician_phone || null,
      jobId,
      jobDate:         row.scheduled_start || row.scheduled_date || null,
      appointmentId:   row.appointment_id,
      technicianName:  row.technician_name,
      customerName:    row.customer_name,
      customerAddress: joinAddress(row),
      jobName:         row.job_name || null,
      jobDescription:  row.job_description || null,
      jobType:         row.job_type || null,
    },
  };
}

// ── open_job_due_soon (customer) — by job_id ────────────────────────────────
async function hydrateOpenJobDueSoon(companyId, jobIdInput) {
  const { rows } = await db.query(
    `SELECT j.id AS job_id, j.scheduled_date, j.status AS job_status,
            j.title AS job_name, j.description AS job_description, j.job_type,
            -- See hydrateScheduledUnconfirmed: the site's phone/name is the
            -- usable contact point when the job has no customer record.
            COALESCE(c.phone, l.phone) AS customer_phone,
            COALESCE(c.full_name, l.name) AS customer_name,
            c.address_line1, c.city, c.state
       FROM jobs j
       LEFT JOIN locations l ON l.id = j.location_id
       -- LEFT, same reason as hydrateScheduledUnconfirmed above: "Job not
       -- found" on an existing job is a misleading 404. Let the phone gate
       -- report the actual gap.
       LEFT JOIN customers c ON c.id = j.customer_id
      WHERE j.id = $1 AND j.company_id = $2
      LIMIT 1`,
    [jobIdInput, companyId]
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "Job not found" };
  if (row.job_status === "cancelled" || row.job_status === "completed") {
    return { ok: false, status: 422, code: "job_closed", error: `Job is ${row.job_status}` };
  }
  // job.scheduled_date is a DATE (no time/tz). "Past" means strictly before
  // today — a job due today is still callable.
  if (row.scheduled_date) {
    const dueDate = new Date(row.scheduled_date);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (dueDate < today) {
      return { ok: false, status: 422, code: "job_in_past", error: "Job scheduled date has already passed" };
    }
  }
  // Phone may be absent — enforced/overridable in manual-call.js.
  const jobId = String(row.job_id);
  return {
    ok: true,
    jobId,
    phoneSubject: "customer",
    callType: "open_job_due_soon",
    params: {
      callType:        "open_job_due_soon",
      phoneNumber:     row.customer_phone || null,
      jobId,
      jobDate:         row.scheduled_date || null,
      customerName:    row.customer_name,
      customerAddress: joinAddress(row),
      jobName:         row.job_name || null,
      jobDescription:  row.job_description || null,
      jobType:         row.job_type || null,
    },
  };
}

// ── job_confirmation (customer) — by job_id ─────────────────────────────────
/**
 * The job-centric confirmation hydrator: one conversation covers every upcoming
 * appointment on a job, leads with the next one, and offers to confirm the rest.
 *
 * Separate from `hydrateScheduledUnconfirmed` rather than an extension of it —
 * that one is keyed by appointment_id and its 422s (`appointment_cancelled`,
 * `appointment_in_past`) are per-appointment eligibility, which is exactly right
 * for `POST /calls/manual`. "Callable if ANY upcoming appointment is
 * unconfirmed" is a different predicate; overloading one function makes both wrong.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.allowNoUpcoming=false] — set by the chat READ path. A
 *   link that's already been delivered must still open even if its appointments
 *   have since been cancelled or slipped into the past; the agent then offers to
 *   book a new visit. Creation paths keep the strict check.
 */
async function hydrateJobConfirmation(companyId, jobIdInput, { allowNoUpcoming = false } = {}) {
  const { buildJobConfirmationContext } = require("./job-confirmation-context");
  const ctx = await buildJobConfirmationContext(companyId, jobIdInput);
  if (!ctx.ok) return { ok: false, status: ctx.status || 404, code: ctx.code, error: ctx.error };

  if (ctx.job.status === "cancelled" || ctx.job.status === "completed") {
    return { ok: false, status: 422, code: "job_closed", error: `Job is ${ctx.job.status}` };
  }
  if (!allowNoUpcoming && ctx.counts.upcoming === 0) {
    return {
      ok: false, status: 422, code: "job_no_upcoming_appointments",
      error: "Job has no upcoming appointments to confirm",
    };
  }

  const jobId = String(ctx.job.id);
  const next = ctx.appointments.next;
  return {
    ok: true,
    jobId,
    phoneSubject: "customer",
    callType: "customer_confirmation",
    // `params` stays flat scheduled_calls columns ONLY — manual-call.js spreads
    // it straight into scheduledCallsDb.create(). The nested context rides on a
    // sibling key so callers that want the rich view can opt in.
    params: {
      callType:        "customer_confirmation",
      phoneNumber:     ctx.job.customer.phone || null,
      jobId,
      // The lead appointment's real day, not a window boundary — this column
      // gates retry/callback scheduling and drives call priority. It's a DATE,
      // so convert in the company's timezone rather than letting Postgres
      // truncate a UTC instant (which can land a day late).
      jobDate:         next ? toLocalDateOnly(next.scheduled_start, ctx.tz) : null,
      appointmentId:   next ? next.appointment_id : null,
      customerName:    ctx.job.customer.name,
      customerAddress: ctx.job.customer.address,
      jobName:         ctx.job.title || null,
      jobDescription:  ctx.job.description || null,
      jobType:         ctx.job.job_type || null,
    },
    context: ctx,
  };
}

// ── quotation_pending (customer) — by quotation_id ──────────────────────────
async function hydrateQuotationPending(companyId, quotationId) {
  const { rows } = await db.query(
    `SELECT q.id AS quotation_id, q.job_id, q.title AS quote_title, q.notes AS quote_description,
            q.total_amount, q.currency,
            c.phone AS customer_phone, c.full_name AS customer_name
       FROM quotations q
       JOIN customers c ON c.id = q.customer_id
      WHERE q.id = $1 AND q.company_id = $2
      LIMIT 1`,
    [quotationId, companyId]
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "Quotation not found" };
  // Phone may be absent — enforced/overridable in manual-call.js.
  // quotations are deduped against a synthetic jobId encoding (see scheduledCallsDb.quotationJobId).
  const jobId = scheduledCallsDb.quotationJobId(row.quotation_id);
  return {
    ok: true,
    jobId,
    realJobId: row.job_id || null,
    phoneSubject: "customer",
    callType: "quotation_pending",
    params: {
      callType:       "quotation_pending",
      phoneNumber:    row.customer_phone || null,
      jobId,
      jobDate:        null,
      customerName:   row.customer_name,
      jobName:        row.quote_title || null,
      jobDescription: row.quote_description || null,
      totalAmount:    row.total_amount ?? null,
    },
  };
}

const HYDRATORS = {
  scheduled_unconfirmed:  hydrateScheduledUnconfirmed,
  technician_unconfirmed: hydrateTechnicianUnconfirmed,
  open_job_due_soon:      hydrateOpenJobDueSoon,
  job_confirmation:       hydrateJobConfirmation,
  quotation_pending:      hydrateQuotationPending,
};

const TARGET_FIELD = {
  scheduled_unconfirmed:  "appointment_id",
  technician_unconfirmed: "appointment_id",
  open_job_due_soon:      "job_id",
  job_confirmation:       "job_id",
  quotation_pending:      "quotation_id",
};

module.exports = {
  hydrateScheduledUnconfirmed,
  hydrateTechnicianUnconfirmed,
  hydrateOpenJobDueSoon,
  hydrateJobConfirmation,
  hydrateQuotationPending,
  HYDRATORS,
  TARGET_FIELD,
};
