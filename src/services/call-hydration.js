/**
 * Per-call-type hydrators for the manual-call API.
 *
 * Each function takes (companyId, targetId) and returns either:
 *   { ok: true, jobId, params }              — params is the exact dict to
 *                                              pass to scheduledCallsDb.create()
 *                                              (minus scheduledAt/isTest/maxAttempts).
 *   { ok: false, status: 404 }               — target not found for this company.
 *   { ok: false, status: 422, error: "..." } — found but cannot dial (e.g. no phone).
 *
 * Mirrors the JOINs in src/services/scheduler.js's four process* functions
 * but filtered to a single target_id so a UI button can place exactly one call.
 */

const db = require("./../db");
const scheduledCallsDb = require("../db/scheduled-calls");

function joinAddress(row) {
  return [row.address_line1, row.city, row.state].filter(Boolean).join(", ") || null;
}

// ── scheduled_unconfirmed (customer) — by appointment_id ────────────────────
async function hydrateScheduledUnconfirmed(companyId, appointmentId) {
  const { rows } = await db.query(
    `SELECT a.id AS appointment_id, a.scheduled_start,
            j.id AS job_id, j.scheduled_date, j.status AS job_status,
            j.title AS job_name, j.description AS job_description, j.job_type,
            c.phone AS customer_phone, c.full_name AS customer_name,
            c.address_line1, c.city, c.state
       FROM appointments a
       JOIN jobs j      ON j.id = a.job_id
       JOIN customers c ON c.id = j.customer_id
      WHERE a.id = $1 AND j.company_id = $2
      LIMIT 1`,
    [appointmentId, companyId]
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "Appointment not found" };
  if (!row.customer_phone) {
    return { ok: false, status: 422, error: "Customer phone number not provided", subject: "customer" };
  }
  const jobId = String(row.job_id);
  return {
    ok: true,
    jobId,
    callType: "scheduled_unconfirmed",
    params: {
      callType:        "scheduled_unconfirmed",
      phoneNumber:     row.customer_phone,
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
    `SELECT a.id AS appointment_id, a.scheduled_start, a.technician_id,
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
  if (!row.technician_id) {
    return { ok: false, status: 422, error: "No technician assigned to this appointment", subject: "technician" };
  }
  if (!row.technician_phone) {
    return { ok: false, status: 422, error: "Technician phone number not provided", subject: "technician" };
  }
  const jobId = String(row.job_id);
  return {
    ok: true,
    jobId,
    callType: "technician_unconfirmed",
    params: {
      callType:        "technician_unconfirmed",
      phoneNumber:     row.technician_phone,
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
    `SELECT j.id AS job_id, j.scheduled_date,
            j.title AS job_name, j.description AS job_description, j.job_type,
            c.phone AS customer_phone, c.full_name AS customer_name,
            c.address_line1, c.city, c.state
       FROM jobs j
       JOIN customers c ON c.id = j.customer_id
      WHERE j.id = $1 AND j.company_id = $2
      LIMIT 1`,
    [jobIdInput, companyId]
  );
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "Job not found" };
  if (!row.customer_phone) {
    return { ok: false, status: 422, error: "Customer phone number not provided", subject: "customer" };
  }
  const jobId = String(row.job_id);
  return {
    ok: true,
    jobId,
    callType: "open_job_due_soon",
    params: {
      callType:        "open_job_due_soon",
      phoneNumber:     row.customer_phone,
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
  if (!row.customer_phone) {
    return { ok: false, status: 422, error: "Customer phone number not provided", subject: "customer" };
  }
  // quotations are deduped against a synthetic jobId encoding (see scheduledCallsDb.quotationJobId).
  const jobId = scheduledCallsDb.quotationJobId(row.quotation_id);
  return {
    ok: true,
    jobId,
    realJobId: row.job_id || null,
    callType: "quotation_pending",
    params: {
      callType:       "quotation_pending",
      phoneNumber:    row.customer_phone,
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
  quotation_pending:      hydrateQuotationPending,
};

const TARGET_FIELD = {
  scheduled_unconfirmed:  "appointment_id",
  technician_unconfirmed: "appointment_id",
  open_job_due_soon:      "job_id",
  quotation_pending:      "quotation_id",
};

module.exports = {
  hydrateScheduledUnconfirmed,
  hydrateTechnicianUnconfirmed,
  hydrateOpenJobDueSoon,
  hydrateQuotationPending,
  HYDRATORS,
  TARGET_FIELD,
};
