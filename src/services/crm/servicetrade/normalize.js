/**
 * Map ServiceTrade raw rows → platform domain rows.
 *
 * Inputs are rows already persisted in our `servicetrade_*` raw tables
 * (snake_case columns), not the wire payloads. Outputs are ready-to-upsert
 * args for the matching platform DB helpers.
 *
 * Rows are NEVER skipped — incomplete data is inserted as-is with a
 * `warnings` array in `additional_information` so the UI can surface a
 * warning badge / note to the user.
 */

/**
 * servicetrade_customers → platform `customers`
 */
function normalizeCustomer(row, { companyId }) {
  if (!row) return null;
  const warnings = [];
  if (!row.phone)     warnings.push({ code: "missing_phone",   message: "Customer has no phone number — calls cannot be placed until added." });
  if (!row.full_name) warnings.push({ code: "missing_name",    message: "Customer has no name." });
  return {
    companyId,
    externalRef:  String(row.servicetrade_id),
    source:       "servicetrade",
    fullName:     row.full_name,
    email:        row.email,
    phone:        row.phone || null,
    addressLine1: row.address_line1,
    city:         row.city,
    state:        row.state,
    zipcode:      row.zipcode,
    country:      row.country || "US",
    isActive:     row.is_active !== false,
    additionalInformation: { servicetrade_customer_id: row.servicetrade_id, warnings },
  };
}

/**
 * servicetrade_jobs → platform `jobs`
 * Caller is responsible for resolving the platform `customerId` from
 * servicetrade_customer_id → customers.external_ref.
 */
function normalizeJob(row, { companyId, customerId }) {
  if (!row) return null;
  const warnings = [];
  if (!customerId && row.servicetrade_customer_id) {
    warnings.push({ code: "unresolved_customer", message: `Could not match ServiceTrade customer ${row.servicetrade_customer_id} to a platform customer.` });
  } else if (!row.servicetrade_customer_id) {
    warnings.push({ code: "no_customer", message: "Job has no associated customer in ServiceTrade." });
  }
  return {
    companyId,
    customerId: customerId || null,
    externalRef:           String(row.servicetrade_id),
    source:                "servicetrade",
    title:                 row.title,
    description:           row.description,
    jobType:               row.job_type,
    status:                mapJobStatus(row.status),
    // Jobs no longer own hard time — the ServiceTrade window syncs into an
    // appointment (normalizeAppointment). The job keeps only the soft deadline.
    dueBy:                  row.scheduled_date,
    additionalInformation: {
      servicetrade_job_id: row.servicetrade_id,
      servicetrade_customer_id: row.servicetrade_customer_id || null,
      warnings,
    },
  };
}

/**
 * servicetrade_appointments → platform `appointments`
 * Caller resolves jobId (platform) from servicetrade_job_id and
 * technicianId from servicetrade_technician_id.
 */
function normalizeAppointment(row, { companyId, jobId, technicianId }) {
  if (!row) return null;
  const warnings = [];
  if (!jobId && row.servicetrade_job_id) {
    warnings.push({ code: "unresolved_job", message: `Could not match ServiceTrade job ${row.servicetrade_job_id} to a platform job.` });
  } else if (!row.servicetrade_job_id) {
    warnings.push({ code: "no_job", message: "Appointment has no associated job in ServiceTrade." });
  }
  if (row.servicetrade_technician_id && !technicianId) {
    warnings.push({ code: "unresolved_technician", message: `Could not match ServiceTrade technician ${row.servicetrade_technician_id} to a platform technician.` });
  }
  if (!row.scheduled_start) {
    warnings.push({ code: "missing_scheduled_start", message: "Appointment has no scheduled start time." });
  }
  return {
    companyId,
    jobId: jobId || null,
    technicianId: technicianId || null,
    externalRef:     String(row.servicetrade_id),
    source:          "servicetrade",
    status:          mapAppointmentStatus(row.status),
    scheduledStart:  row.scheduled_start,
    scheduledEnd:    row.scheduled_end,
    additionalInformation: {
      servicetrade_appointment_id: row.servicetrade_id,
      servicetrade_job_id: row.servicetrade_job_id || null,
      servicetrade_technician_id: row.servicetrade_technician_id || null,
      warnings,
    },
  };
}

/**
 * servicetrade_technicians → platform `technicians`
 * Phone is required (NOT NULL on platform side) — returns null otherwise.
 */
function normalizeTechnician(row, { companyId }) {
  if (!row) return null;
  const warnings = [];
  if (!row.phone)      warnings.push({ code: "missing_phone", message: "Technician has no phone number — confirmation calls cannot be placed." });
  if (!row.first_name && !row.last_name) warnings.push({ code: "missing_name", message: "Technician has no name." });
  return {
    companyId,
    externalRef: String(row.servicetrade_id),
    source:      "servicetrade",
    firstName:   row.first_name || null,
    lastName:    row.last_name  || null,
    email:       row.email,
    phone:       row.phone || null,
    isActive:    row.is_active !== false,
    additionalInformation: { servicetrade_technician_id: row.servicetrade_id, warnings },
  };
}

// ── Status mappers ──────────────────────────────────────────────────────────

function mapJobStatus(s) {
  switch (s) {
    case "new":         return "open";
    case "scheduled":   return "scheduled";
    case "confirmed":   return "confirmed";
    case "in_progress":
    case "inProgress":  return "in_progress";
    case "completed":
    case "done":        return "completed";
    case "canceled":
    case "cancelled":   return "cancelled";
    default:            return "open";
  }
}

function mapAppointmentStatus(s) {
  switch (s) {
    case "scheduled":   return "scheduled";
    case "confirmed":   return "confirmed";
    case "rescheduled": return "rescheduled";
    case "canceled":
    case "cancelled":   return "cancelled";
    case "completed":   return "completed";
    case "no_show":
    case "noShow":      return "no_show";
    default:            return "scheduled";
  }
}

module.exports = {
  normalizeCustomer,
  normalizeJob,
  normalizeAppointment,
  normalizeTechnician,
  mapJobStatus,
  mapAppointmentStatus,
};
