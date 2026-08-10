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

const { toE164 } = require("../../../utils/phone");

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
 * servicetrade_customer_id → customers.external_ref, and the FK ids below from
 * the job's embedded owner/sales/office/project/contract/currentAppointment/
 * location/primaryContact (each resolved via its own external_ref lookup
 * before calling this).
 */
function normalizeJob(row, {
  companyId, customerId, ownerId, salespersonId, assignedOfficeId, projectId, contractId, currentAppointmentId,
  locationId, primaryContactId,
}) {
  if (!row) return null;
  const warnings = [];
  if (!customerId && row.servicetrade_customer_id) {
    warnings.push({ code: "unresolved_customer", message: `Could not match ServiceTrade customer ${row.servicetrade_customer_id} to a platform customer.` });
  } else if (!row.servicetrade_customer_id) {
    warnings.push({ code: "no_customer", message: "Job has no associated customer in ServiceTrade." });
  }
  const payload = row.payload || {};
  return {
    companyId,
    customerId: customerId || null,
    externalRef:           String(row.servicetrade_id),
    source:                "servicetrade",
    title:                 row.title,
    description:           row.description,
    jobType:               row.job_type,
    status:                mapJobStatus(row.status),
    scheduledDate:         row.scheduled_date,
    scheduledWindowStart:  row.scheduled_window_start,
    scheduledWindowEnd:    row.scheduled_window_end,
    jobNumber:             payload.number ?? null,
    ownerId:               ownerId || null,
    salespersonId:         salespersonId || null,
    assignedOfficeId:      assignedOfficeId || null,
    projectId:             projectId || null,
    contractId:            contractId || null,
    currentAppointmentId:  currentAppointmentId || null,
    locationId:            locationId || null,
    primaryContactId:      primaryContactId || null,
    externalIds:           payload.externalIds || {},
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
  const payload = row.payload || {};
  return {
    companyId,
    jobId: jobId || null,
    technicianId: technicianId || null,
    externalRef:     String(row.servicetrade_id),
    source:          "servicetrade",
    status:          mapAppointmentStatus(row.status),
    scheduledStart:  row.scheduled_start,
    scheduledEnd:    row.scheduled_end,
    duration:        payload.duration ?? null,
    released:        payload.released ?? null,
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

/**
 * servicetrade_projects → platform `projects`
 * Sourced from a job's embedded `project` — no dedicated bulk sync.
 */
function normalizeProject(row, { companyId }) {
  if (!row) return null;
  return {
    companyId,
    externalRef: String(row.servicetrade_id),
    source:      "servicetrade",
    startDate:   row.start_date,
    endDate:     row.end_date,
    additionalInformation: { servicetrade_project_id: row.servicetrade_id },
  };
}

/**
 * servicetrade_users → platform `crm_users`
 * Sourced from a job's embedded `owner`/`sales` — a ServiceTrade "User", not
 * the same shape as a `technician` (no phone/first-last split required here).
 */
function normalizeCrmUser(row, { companyId }) {
  if (!row) return null;
  return {
    companyId,
    externalRef: String(row.servicetrade_id),
    source:      "servicetrade",
    name:        row.name || null,
    email:       row.email || null,
    status:      row.status || null,
    isTech:      row.is_tech,
    isHelper:    row.is_helper,
    additionalInformation: { servicetrade_user_id: row.servicetrade_id },
  };
}

/**
 * A job's embedded `schedulingComments[]` item ({id, uri, job_id, content}) →
 * platform `scheduling_comments`. Has a real ServiceTrade id, so it's
 * upserted by external_ref like everything else — no dedicated raw table,
 * read directly off the parent job's raw `payload`.
 */
function normalizeSchedulingComment(item, { companyId, jobId }) {
  if (!item || item.id == null) return null;
  return {
    companyId,
    jobId,
    externalRef: String(item.id),
    source:      "servicetrade",
    content:     item.content ?? null,
  };
}

/**
 * A /comment row (ServiceTrade's real per-job comment stream) → platform
 * `job_comments`. `created`/`updated` are unix seconds; they're carried
 * through as real timestamps because comment RECENCY is what distinguishes
 * "customer confirmed" from a later "customer called to reschedule" — our
 * own row timestamps move on every sync and can't be used for that.
 */
function normalizeJobComment(item, { companyId, jobId }) {
  if (!item || item.id == null) return null;
  const toTs = (unix) => (Number.isFinite(Number(unix)) ? new Date(Number(unix) * 1000).toISOString() : null);
  return {
    companyId,
    jobId,
    externalRef:   String(item.id),
    source:        "servicetrade",
    content:       item.content ?? null,
    authorName:    item.author?.name ?? null,
    authorEmail:   item.author?.email ?? null,
    authorIsTech:  typeof item.author?.isTech === "boolean" ? item.author.isTech : null,
    commentedAt:   toTs(item.created),
    stUpdatedAt:   toTs(item.updated),
    pinned:        item.pinned === true,
    visibility:    Array.isArray(item.visibility) ? item.visibility : null,
    additionalInformation: { servicetrade_comment_id: String(item.id) },
  };
}

/**
 * A job's embedded `notes[]` item ({type, text}) → platform `job_notes`.
 * No id/stable identity in the payload — caller re-syncs by delete-and-reinsert
 * per job rather than upserting by external_ref.
 */
function normalizeJobNote(item, { companyId, jobId }) {
  if (!item) return null;
  return { companyId, jobId, type: item.type ?? null, text: item.text ?? null };
}

/**
 * An appointment's embedded `notes[]` item ({type, text}) → platform
 * `appointment_notes`. Same no-id, delete-and-reinsert pattern as job_notes.
 */
function normalizeAppointmentNote(item, { companyId, appointmentId }) {
  if (!item) return null;
  return { companyId, appointmentId, type: item.type ?? null, text: item.text ?? null };
}

/**
 * servicetrade_contacts → platform `contacts`
 * Sourced from a location's embedded `primaryContact` — no dedicated /contact sync.
 */
function normalizeContact(row, { companyId, isPrimary = false }) {
  if (!row) return null;
  const warnings = [];
  if (!row.phone && !row.mobile) warnings.push({ code: "missing_phone", message: "Contact has no phone or mobile number." });
  return {
    companyId,
    externalRef:    String(row.servicetrade_id),
    source:         "servicetrade",
    firstName:      row.first_name || null,
    lastName:       row.last_name  || null,
    phone:          toE164(row.phone),
    mobile:         toE164(row.mobile),
    alternatePhone: toE164(row.alternate_phone),
    email:          row.email || null,
    type:           row.type || null,
    status:         row.status || null,
    types:          row.types || null,
    externalIds:    row.external_ids || null,
    // Platform's own classification, distinct from `type`/`types` (which are
    // the CRM's free-text labels). "primary" means ServiceTrade names this
    // contact as the primaryContact of a job or a location; caller decides.
    contactRole:    isPrimary ? "primary" : "general",
    additionalInformation: { servicetrade_contact_id: row.servicetrade_id, warnings },
  };
}

/**
 * servicetrade_offices → platform `offices`
 * Sourced from a location's embedded `offices[]` — no dedicated bulk sync.
 */
function normalizeOffice(row, { companyId }) {
  if (!row) return null;
  const warnings = [];
  if (!row.name) warnings.push({ code: "missing_name", message: "Office has no name." });
  return {
    companyId,
    externalRef:  String(row.servicetrade_id),
    source:       "servicetrade",
    name:         row.name || null,
    addressLine1: row.address_line1,
    city:         row.city,
    state:        row.state,
    zipcode:      row.zipcode,
    country:      row.country || "US",
    lat:          row.lat,
    lon:          row.lon,
    phone:        toE164(row.phone),
    email:        row.email || null,
    isActive:     row.is_active !== false,
    additionalInformation: { servicetrade_office_id: row.servicetrade_id, warnings },
  };
}

/**
 * servicetrade_tags → platform `tags`
 * Sourced from a location's embedded `tags[]` — no dedicated bulk sync.
 */
function normalizeTag(row, { companyId }) {
  if (!row) return null;
  return {
    companyId,
    externalRef: String(row.servicetrade_id),
    source:      "servicetrade",
    name:        row.name || null,
    additionalInformation: { servicetrade_tag_id: row.servicetrade_id },
  };
}

/**
 * servicetrade_locations → platform `locations` — the fundamental entity.
 * Caller resolves customerId (from servicetrade_customer_id) and
 * primaryContactId (from servicetrade_primary_contact_id) via their
 * respective external_ref lookups.
 */
function normalizeLocation(row, { companyId, customerId, primaryContactId }) {
  if (!row) return null;
  const warnings = [];
  if (!customerId && row.servicetrade_customer_id) {
    warnings.push({ code: "unresolved_customer", message: `Could not match ServiceTrade company ${row.servicetrade_customer_id} to a platform customer.` });
  }
  if (!primaryContactId && row.servicetrade_primary_contact_id) {
    warnings.push({ code: "unresolved_contact", message: `Could not match ServiceTrade contact ${row.servicetrade_primary_contact_id} to a platform contact.` });
  }
  const phone = toE164(row.phone);
  if (!phone) warnings.push({ code: "missing_phone", message: "Location has no usable phone number." });
  return {
    companyId,
    customerId:        customerId || null,
    primaryContactId:  primaryContactId || null,
    externalRef:            String(row.servicetrade_id),
    source:                 "servicetrade",
    name:                   row.name,
    lat:                    row.lat,
    lon:                    row.lon,
    phone,
    email:                  row.email,
    generalManagerName:     row.general_manager_name || null,
    addressLine1:           row.address_line1,
    city:                   row.city,
    state:                  row.state,
    zipcode:                row.zipcode,
    country:                row.country || "US",
    taxable:                row.taxable,
    company:                row.company,
    brand:                  row.brand,
    isActive:               row.is_active !== false,
    additionalInformation: {
      servicetrade_location_id: row.servicetrade_id,
      servicetrade_customer_id: row.servicetrade_customer_id || null,
      warnings,
    },
  };
}

/** servicetrade_service_lines → platform `service_lines` */
function normalizeServiceLine(row, { companyId }) {
  if (!row) return null;
  return {
    companyId,
    externalRef: String(row.servicetrade_id),
    source:      "servicetrade",
    name:        row.name || null,
    trade:       row.trade || null,
    abbr:        row.abbr || null,
    icon:        row.icon || null,
    additionalInformation: { servicetrade_service_line_id: row.servicetrade_id },
  };
}

/** servicetrade_deficiencies → platform `deficiencies` */
function normalizeDeficiency(row, { companyId }) {
  if (!row) return null;
  return {
    companyId,
    externalRef: String(row.servicetrade_id),
    source:      "servicetrade",
    refNumber:   row.ref_number || null,
    name:        row.name || null,
    description: row.description || null,
    additionalInformation: { servicetrade_deficiency_id: row.servicetrade_id },
  };
}

/** servicetrade_change_orders → platform `change_orders` */
function normalizeChangeOrder(row, { companyId }) {
  if (!row) return null;
  return {
    companyId,
    externalRef:     String(row.servicetrade_id),
    source:          "servicetrade",
    status:          row.status || null,
    type:            row.type || null,
    referenceNumber: row.reference_number || null,
    additionalInformation: { servicetrade_change_order_id: row.servicetrade_id },
  };
}

/** servicetrade_contracts → platform `contracts` */
function normalizeContract(row, { companyId }) {
  if (!row) return null;
  return {
    companyId,
    externalRef: String(row.servicetrade_id),
    source:      "servicetrade",
    name:        row.name || null,
    additionalInformation: { servicetrade_contract_id: row.servicetrade_id },
  };
}

/** servicetrade_service_recurrences → platform `service_recurrences` */
function normalizeServiceRecurrence(row, { companyId }) {
  if (!row) return null;
  return {
    companyId,
    externalRef:        String(row.servicetrade_id),
    source:              "servicetrade",
    description:         row.description || null,
    frequency:           row.frequency || null,
    recurrenceInterval:  row.recurrence_interval,
    repeatWeekday:       row.repeat_weekday,
    additionalInformation: { servicetrade_service_recurrence_id: row.servicetrade_id },
  };
}

/**
 * servicetrade_service_requests → platform `service_requests`.
 * Covers EVERY request, job-linked or not — the caller resolves all FK ids
 * via their respective external_ref lookups (any of which may legitimately
 * be null; only `company_id` is required on this table).
 */
function normalizeServiceRequest(row, {
  companyId, locationId, jobId, deficiencyId, changeOrderId, contractId, serviceRecurrenceId, serviceLineId,
}) {
  if (!row) return null;
  return {
    companyId,
    locationId:           locationId || null,
    jobId:                jobId || null,
    deficiencyId:         deficiencyId || null,
    changeOrderId:        changeOrderId || null,
    contractId:           contractId || null,
    serviceRecurrenceId:  serviceRecurrenceId || null,
    serviceLineId:        serviceLineId || null,
    externalRef:          String(row.servicetrade_id),
    source:               "servicetrade",
    status:               row.status,
    description:          row.description,
    windowStart:          row.window_start,
    windowEnd:            row.window_end,
    closedOn:             row.closed_on,
    estimatedPrice:       row.estimated_price,
    duration:             row.duration,
    preferredStartTime:   row.preferred_start_time,
    budget:               row.budget,
    preferredVendor:      row.preferred_vendor,
    asset:                row.asset,
    visibility:           row.visibility,
    additionalInformation: { servicetrade_service_request_id: row.servicetrade_id },
  };
}

/**
 * platform `service_requests` (WHERE job_id IS NULL) → platform
 * `service_opportunities`. Every FK id on a service_requests row is already a
 * resolved platform id (it went through normalizeServiceRequest first), so
 * this just reshapes the row — no external_ref resolution here. `location_id`
 * is NOT NULL on service_opportunities, so this returns null if the source
 * row somehow lacks one.
 */
function normalizeServiceOpportunity(row) {
  if (!row) return null;
  if (!row.location_id) return null; // location_id is NOT NULL — nothing to insert without it
  return {
    companyId:            row.company_id,
    locationId:           row.location_id,
    jobId:                row.job_id || null,
    deficiencyId:         row.deficiency_id || null,
    changeOrderId:        row.change_order_id || null,
    contractId:           row.contract_id || null,
    serviceRecurrenceId:  row.service_recurrence_id || null,
    serviceLineId:        row.service_line_id || null,
    externalRef:          row.external_ref,
    source:               row.source,
    status:               row.status,
    description:          row.description,
    windowStart:          row.window_start,
    windowEnd:            row.window_end,
    closedOn:             row.closed_on,
    estimatedPrice:       row.estimated_price,
    duration:             row.duration,
    preferredStartTime:   row.preferred_start_time,
    budget:               row.budget,
    preferredVendor:      row.preferred_vendor,
    asset:                row.asset,
    visibility:           row.visibility,
    additionalInformation: row.additional_information || {},
  };
}

/**
 * servicetrade_service_requests → platform `appointment_services`.
 * Only called for requests that came from an appointment DETAIL fetch
 * (servicetrade_appointment_id IS NOT NULL) — the caller resolves all FK ids
 * via their external_ref lookups. `appointment_id` is NOT NULL on the platform
 * table, so this returns null if unresolved (mirrors normalizeServiceOpportunity's
 * location_id-required pattern).
 */
function normalizeAppointmentService(row, { companyId, appointmentId, jobId, serviceLineId }) {
  if (!row) return null;
  const warnings = [];
  if (!appointmentId) {
    warnings.push({ code: "unresolved_appointment", message: `Could not match ServiceTrade appointment ${row.servicetrade_appointment_id} to a platform appointment.` });
    return null; // appointment_id is NOT NULL — nothing to insert without it
  }
  return {
    companyId,
    appointmentId,
    jobId:          jobId || null,
    serviceLineId:  serviceLineId || null,
    externalRef:    String(row.servicetrade_id),
    source:         "servicetrade",
    status:         row.status,
    completion:     row.completion,
    description:    row.description,
    windowStart:    row.window_start,
    windowEnd:      row.window_end,
    duration:       row.duration,
    estimatedPrice: row.estimated_price,
    asset:          row.asset,
    additionalInformation: {
      servicetrade_service_request_id: row.servicetrade_id,
      servicetrade_appointment_id: row.servicetrade_appointment_id,
      warnings,
    },
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
  normalizeProject,
  normalizeCrmUser,
  normalizeSchedulingComment,
  normalizeJobComment,
  normalizeJobNote,
  normalizeAppointmentNote,
  normalizeContact,
  normalizeOffice,
  normalizeTag,
  normalizeLocation,
  normalizeServiceLine,
  normalizeDeficiency,
  normalizeChangeOrder,
  normalizeContract,
  normalizeServiceRecurrence,
  normalizeServiceRequest,
  normalizeServiceOpportunity,
  normalizeAppointmentService,
  mapJobStatus,
  mapAppointmentStatus,
};
