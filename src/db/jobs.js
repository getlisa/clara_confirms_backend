const db = require("./index");

// Must match services/job-confirmation-context.js's UPCOMING_STATUSES exactly —
// not imported directly to avoid a circular require (that module requires this
// one for getJobById). Kept here as a literal, checked against the other by
// the verification pass in the confirmation-scheduling plan.
const UPCOMING_APPOINTMENT_STATUSES = ["scheduled", "confirmed", "rescheduled"];

function jobRow(row) {
  return {
    id:                     row.id,
    company_id:             row.company_id,
    customer_id:            row.customer_id,
    technician_id:          row.technician_id ?? null,
    job_number:             row.job_number ?? null,
    title:                  row.title ?? null,
    description:            row.description ?? null,
    job_type:               row.job_type ?? null,
    status:                 row.status,
    scheduled_date:         row.scheduled_date ?? null,
    scheduled_window_start: row.scheduled_window_start ?? null,
    scheduled_window_end:   row.scheduled_window_end ?? null,
    external_ref:           row.external_ref ?? null,
    source:                 row.source ?? null,
    additional_information: row.additional_information ?? {},
    created_at:             row.created_at,
    updated_at:             row.updated_at,
  };
}

function apptRow(row) {
  return {
    id:                       row.id,
    job_id:                   row.job_id,
    technician_id:            row.technician_id ?? null,
    scheduled_start:          row.scheduled_start,
    scheduled_end:            row.scheduled_end ?? null,
    status:                   row.status,
    customer_confirmed:       row.customer_confirmed ?? null,
    technician_confirmed:     row.technician_confirmed ?? null,
    customer_confirmed_at:    row.customer_confirmed_at ?? null,
    technician_confirmed_at:  row.technician_confirmed_at ?? null,
    reschedule_requested:     row.reschedule_requested,
    rescheduled_to:           row.rescheduled_to ?? null,
    previous_appointment_id:  row.previous_appointment_id ?? null,
    cancellation_reason:      row.cancellation_reason ?? null,
    external_ref:             row.external_ref ?? null,
    source:                   row.source ?? null,
    additional_information:   row.additional_information ?? {},
    created_at:               row.created_at,
    updated_at:               row.updated_at,
    // Joined fields (present on list queries)
    technician_name:          row.technician_name ?? null,
    technician_phone:         row.technician_phone ?? null,
  };
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

// Accepts either a single value or a comma-separated list (or an array) and
// always pushes an array param — lets the frontend send status=scheduled
// (unchanged single-value behavior) or status=scheduled,confirmed without a
// separate code path.
function toList(value) {
  if (value == null || value === "") return null;
  if (Array.isArray(value)) return value;
  return String(value).split(",").map((v) => v.trim()).filter(Boolean);
}

async function listJobs(companyId, {
  status, jobType, customerId, technicianId, locationId,
  scheduledDateFrom, scheduledDateTo, tz,
  dueSoonDays, confirmed,
  search, limit = 50, offset = 0,
} = {}) {
  const conditions = ["j.company_id = $1"];
  const values = [companyId];
  let i = 2;

  const statusList = toList(status);
  const jobTypeList = toList(jobType);
  const customerIdList = toList(customerId);
  const locationIdList = toList(locationId);

  if (statusList)      { conditions.push(`j.status = ANY($${i++}::varchar[])`);      values.push(statusList); }
  if (jobTypeList)     { conditions.push(`j.job_type = ANY($${i++}::varchar[])`);     values.push(jobTypeList); }
  if (customerIdList)  { conditions.push(`j.customer_id = ANY($${i++}::int[])`);      values.push(customerIdList.map(Number)); }
  if (technicianId)    { conditions.push(`j.technician_id = $${i++}`);                values.push(technicianId); }
  if (locationIdList)  { conditions.push(`j.location_id = ANY($${i++}::int[])`);      values.push(locationIdList.map(Number)); }
  // Filters on any of the job's APPOINTMENTS falling in this date range, not
  // jobs.scheduled_date — a job with several appointments should show up for
  // a date-range query ("what's scheduled this week?") if ANY of its visits
  // lands in that window, not just its own single scheduled_date field, which
  // doesn't track per-visit dates. Dates are compared in the company's
  // timezone (same convention as the confirmation sweep's date windows), not
  // UTC, so a late-evening appointment isn't miscounted onto the next day.
  // Cancelled appointments don't count as "scheduled" for this purpose.
  if (scheduledDateFrom || scheduledDateTo) {
    const apptConditions = ["a2.company_id = j.company_id", "a2.job_id = j.id", "a2.status != 'cancelled'"];
    const companyTz = tz || "America/New_York";
    if (scheduledDateFrom) {
      apptConditions.push(`DATE(a2.scheduled_start AT TIME ZONE $${i++}) >= $${i++}::date`);
      values.push(companyTz, scheduledDateFrom);
    }
    if (scheduledDateTo) {
      apptConditions.push(`DATE(a2.scheduled_start AT TIME ZONE $${i++}) <= $${i++}::date`);
      values.push(companyTz, scheduledDateTo);
    }
    conditions.push(`EXISTS (SELECT 1 FROM appointments a2 WHERE ${apptConditions.join(" AND ")})`);
  }
  if (dueSoonDays != null) {
    // Jobs whose scheduled_date falls between today and today + N days (inclusive)
    conditions.push(`j.scheduled_date >= CURRENT_DATE AND j.scheduled_date <= CURRENT_DATE + ($${i++} || ' days')::interval`);
    values.push(dueSoonDays);
  }
  // confirmed=false is the filter that makes manual job selection usable
  // ("show me what still needs confirming") — checked against the job's
  // upcoming appointments as a set (any unconfirmed upcoming => not
  // confirmed), not just the single "active" appointment used for display.
  if (confirmed === true || confirmed === false) {
    // One param, referenced by both subqueries below.
    const p = i++;
    values.push(UPCOMING_APPOINTMENT_STATUSES);

    // "Outstanding" (booked, not completed/cancelled, regardless of start
    // time) — the SAME definition job-confirmation-status.js derives
    // jobs.status from. These must agree: with a future-only test here, a job
    // whose confirmed visit had already started showed status 'confirmed' but
    // was missing from ?confirmed=true.
    const outstanding = `SELECT 1 FROM appointments up
       WHERE up.job_id = j.id AND up.company_id = j.company_id
         AND up.status = ANY($${p}::varchar[])`;
    const unconfirmedCount = `SELECT COUNT(*) FROM appointments up
       WHERE up.job_id = j.id AND up.company_id = j.company_id
         AND up.status = ANY($${p}::varchar[])
         AND COALESCE(up.customer_confirmed, false) = false`;

    if (confirmed) {
      // The EXISTS is load-bearing. "Zero unconfirmed outstanding
      // appointments" is VACUOUSLY true for a job with none outstanding, so
      // without it confirmed=true returned jobs nobody ever confirmed — every
      // visit simply completed. Measured before this guard: company 4 had
      // 435 matches, 435 of them vacuous (zero genuine); company 9 had 27, of
      // which 10 were vacuous.
      conditions.push(`EXISTS (${outstanding}) AND (${unconfirmedCount}) = 0`);
    } else {
      // No EXISTS needed: a non-zero unconfirmed count already implies at
      // least one outstanding appointment.
      conditions.push(`(${unconfirmedCount}) > 0`);
    }
  }
  if (search) {
    conditions.push(`(j.title ILIKE $${i} OR c.full_name ILIKE $${i})`);
    values.push(`%${search}%`);
    i++;
  }

  const where = conditions.join(" AND ");

  // `values` deliberately does NOT get limit/offset appended — they're spread
  // into the rows query only. The count query has no LIMIT/OFFSET, so sharing
  // a mutated array would leave it with two extra params and throw on every
  // filtered request.
  const [result, countResult] = await Promise.all([
    db.query(
    `SELECT j.*,
            c.full_name       AS customer_name,
            c.phone           AS customer_phone,
            c.address_line1   AS customer_address,
            c.city            AS customer_city,
            c.state           AS customer_state,
            t.first_name || ' ' || t.last_name AS technician_name,
            t.phone           AS technician_phone,
            a.id              AS active_appointment_id,
            a.scheduled_start AS active_appointment_start,
            a.scheduled_end   AS active_appointment_end,
            a.status          AS active_appointment_status,
            a.customer_confirmed,
            a.technician_confirmed
     FROM jobs j
     JOIN customers c ON c.id = j.customer_id
     LEFT JOIN technicians t ON t.id = j.technician_id
     LEFT JOIN LATERAL (
       SELECT * FROM appointments ap
       WHERE ap.job_id = j.id AND ap.status NOT IN ('cancelled','rescheduled')
       ORDER BY ap.scheduled_start DESC LIMIT 1
     ) a ON true
     WHERE ${where}
     ORDER BY j.scheduled_date ASC NULLS LAST, j.created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    ),
    // JOIN customers is required, not optional: it's an INNER join, so it can
    // exclude jobs (a job whose customer row is missing), and `search` filters
    // on c.full_name. Without it `total` could exceed the rows actually
    // returnable, or the count would fail outright on a search.
    //
    // The LEFT JOIN LATERAL is deliberately omitted — it only populates
    // active_appointment and can neither exclude nor duplicate rows, so it's
    // pure cost here.
    //
    // COUNT(*) rather than COUNT(DISTINCT j.id): both appointment-based
    // filters (the scheduled_date window and `confirmed`) are written as
    // EXISTS / scalar subqueries, so there is exactly one row per job.
    db.query(
      `SELECT COUNT(*)::int AS n
         FROM jobs j
         JOIN customers c ON c.id = j.customer_id
        WHERE ${where}`,
      values
    ),
  ]);

  const rows = result.rows.map((row) => ({
    ...jobRow(row),
    customer_name:             row.customer_name ?? null,
    customer_phone:            row.customer_phone ?? null,
    customer_address:          [row.customer_address, row.customer_city, row.customer_state].filter(Boolean).join(", ") || null,
    technician_name:           row.technician_name ?? null,
    technician_phone:          row.technician_phone ?? null,
    active_appointment: row.active_appointment_id ? {
      id:                  row.active_appointment_id,
      scheduled_start:     row.active_appointment_start,
      scheduled_end:       row.active_appointment_end,
      status:              row.active_appointment_status,
      customer_confirmed:  row.customer_confirmed,
      technician_confirmed: row.technician_confirmed,
    } : null,
  }));

  return { rows, total: countResult.rows[0].n };
}

// Distinct job types actually present for this company — the sync ingests up
// to 24 ServiceTrade technician-visit types (servicetrade-sync.js's
// TECHNICIAN_JOB_TYPES), but the frontend's filter dropdown had hardcoded only
// 5, silently hiding most jobs from that filter.
async function listJobTypes(companyId) {
  const { rows } = await db.query(
    `SELECT DISTINCT job_type FROM jobs
      WHERE company_id = $1 AND job_type IS NOT NULL
      ORDER BY job_type`,
    [companyId]
  );
  return rows.map((r) => r.job_type);
}

async function getJobById(id, companyId) {
  const result = await db.query(
    `SELECT j.*,
            c.full_name     AS customer_name,
            c.phone         AS customer_phone,
            c.email         AS customer_email,
            c.address_line1, c.city, c.state, c.zipcode,
            t.first_name || ' ' || t.last_name AS technician_name,
            t.phone         AS technician_phone,
            t.email         AS technician_email
     FROM jobs j
     JOIN customers c  ON c.id = j.customer_id
     LEFT JOIN technicians t ON t.id = j.technician_id
     WHERE j.id = $1 AND j.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) return null;

  const row = result.rows[0];
  const job = {
    ...jobRow(row),
    customer: {
      id:           row.customer_id,
      full_name:    row.customer_name,
      phone:        row.customer_phone,
      email:        row.customer_email ?? null,
      address_line1: row.address_line1 ?? null,
      city:         row.city ?? null,
      state:        row.state ?? null,
      zipcode:      row.zipcode ?? null,
    },
    technician: row.technician_id ? {
      id:    row.technician_id,
      name:  row.technician_name,
      phone: row.technician_phone,
      email: row.technician_email ?? null,
    } : null,
  };

  // All appointments for this job (full history)
  const appts = await db.query(
    `SELECT a.*,
            t.first_name || ' ' || t.last_name AS technician_name,
            t.phone AS technician_phone
     FROM appointments a
     LEFT JOIN technicians t ON t.id = a.technician_id
     WHERE a.job_id = $1
     ORDER BY a.scheduled_start DESC`,
    [id]
  );
  job.appointments = appts.rows.map(apptRow);

  // What each visit is actually FOR. Attached per appointment rather than as one
  // flat job-level list, because different appointments on the same job are
  // routinely different services.
  const servicesByAppt = await fetchServicesByAppointment(
    companyId,
    job.appointments.map((a) => a.id)
  );
  // Every technician assigned to the visit, not just the one on
  // appointments.technician_id (that column holds only the first/primary
  // tech — a visit can have several, tracked in the appointment_technicians
  // junction table; see migration 075).
  const techsByAppt = await fetchTechniciansByAppointment(
    job.appointments.map((a) => a.id)
  );
  for (const appt of job.appointments) {
    appt.services = servicesByAppt.get(appt.id) || [];
    appt.service_line = appt.services[0]?.service_line ?? null;
    appt.technicians = techsByAppt.get(appt.id) || [];
  }

  // Quotations for this job
  const quotes = await db.query(
    `SELECT id, quote_number, title, status, total_amount, currency, valid_until, created_at
     FROM quotations WHERE job_id = $1 ORDER BY created_at DESC`,
    [id]
  );
  job.quotations = quotes.rows;

  job.contacts = await getJobContacts(id, companyId, row);

  return job;
}

/**
 * Services grouped by appointment → Map<appointment_id, service[]>.
 *
 * Keyed on `appointment_id`, deliberately NOT on `appointment_services.job_id`:
 * that column is nullable (migrations/065) and is frequently NULL, because
 * `normalizeAppointmentService` only requires an appointmentId and resolves
 * jobId through an external-ref map that can miss. A job-keyed query therefore
 * silently loses services that are correctly attached to an appointment.
 */
async function fetchServicesByAppointment(companyId, appointmentIds) {
  const grouped = new Map();
  if (!appointmentIds || appointmentIds.length === 0) return grouped;
  const { rows } = await db.query(
    `SELECT aps.appointment_id, aps.description, aps.status, aps.completion,
            aps.estimated_price, aps.duration,
            sl.name AS service_line_name, sl.trade AS service_line_trade
       FROM appointment_services aps
       LEFT JOIN service_lines sl ON sl.id = aps.service_line_id
      WHERE aps.company_id = $1 AND aps.appointment_id = ANY($2::int[])
      ORDER BY aps.appointment_id, aps.id`,
    [companyId, appointmentIds]
  );
  for (const r of rows) {
    const serviceLine = [r.service_line_name, r.service_line_trade].filter(Boolean).join(" / ") || null;
    if (!grouped.has(r.appointment_id)) grouped.set(r.appointment_id, []);
    grouped.get(r.appointment_id).push({
      service_line:    serviceLine,
      description:     r.description ?? null,
      status:          r.status ?? null,
      completion:      r.completion ?? null,
      estimated_price: r.estimated_price ?? null,
      duration:        r.duration ?? null,
    });
  }
  return grouped;
}

/**
 * Every technician assigned to each appointment → Map<appointment_id, tech[]>.
 * `appointment_technicians` has no company_id — tenant scoping comes from the
 * appointment ids, which the caller already scoped by company.
 */
async function fetchTechniciansByAppointment(appointmentIds) {
  const grouped = new Map();
  if (!appointmentIds || appointmentIds.length === 0) return grouped;
  const { rows } = await db.query(
    `SELECT at.appointment_id, t.id, t.first_name || ' ' || t.last_name AS name, t.phone, t.email
       FROM appointment_technicians at
       JOIN technicians t ON t.id = at.technician_id
      WHERE at.appointment_id = ANY($1::int[])`,
    [appointmentIds]
  );
  for (const r of rows) {
    if (!grouped.has(r.appointment_id)) grouped.set(r.appointment_id, []);
    grouped.get(r.appointment_id).push({
      id:    r.id,
      name:  (r.name || "").trim() || null,
      phone: r.phone ?? null,
      email: r.email ?? null,
    });
  }
  return grouped;
}

/**
 * Service lines known at the JOB level, from `service_requests` (which has a
 * job_id but no appointment_id). Used only as a fallback to name the work when
 * an appointment has no `appointment_services` rows — never to invent
 * per-appointment services.
 */
async function fetchJobServiceLines(companyId, jobId) {
  const { rows } = await db.query(
    `SELECT DISTINCT sl.name, sl.trade
       FROM service_requests sr
       JOIN service_lines sl ON sl.id = sr.service_line_id
      WHERE sr.company_id = $1 AND sr.job_id = $2`,
    [companyId, jobId]
  );
  return rows.map((r) => [r.name, r.trade].filter(Boolean).join(" / ")).filter(Boolean);
}

/**
 * Every person worth contacting about a job, as ONE list with a `role`.
 *
 * Two different underlying entity types are deliberately merged here, so
 * `source` distinguishes them:
 *   - `contact`  — a customer-side contact (platform `contacts` table)
 *   - `crm_user` — internal staff synced from the CRM (`crm_users`), i.e. the
 *                  job owner / salesperson, NOT someone at the customer
 *
 * Roles: exactly one `primary` — the job's own primary contact — then any
 * number of `general` contacts (everyone else linked to the job's customer or
 * location), plus `job_owner` (jobs.owner_id) and `sales` (jobs.salesperson_id)
 * for internal staff.
 *
 * `primary` is decided PER JOB from jobs.primary_contact_id, not from
 * contacts.contact_role. A person flagged `contact_role = 'primary'` is the
 * primary somewhere on the account, which isn't necessarily on this job — so
 * using the column directly could yield several primaries in one list. The
 * column is still returned as `contact_role` for callers that want it.
 *
 * One person can legitimately hold two roles (ServiceTrade commonly sets the
 * same user as both owner and salesperson) — they appear once per role rather
 * than being collapsed, so the caller can render each role independently.
 */
async function getJobContacts(jobId, companyId, jobRowData = null) {
  const row = jobRowData || (await db.query(
    "SELECT customer_id, location_id, primary_contact_id, owner_id, salesperson_id FROM jobs WHERE id = $1 AND company_id = $2",
    [jobId, companyId]
  )).rows[0];
  if (!row) return [];

  const contacts = [];

  // Customer-side contacts: the job's own primary contact plus anyone linked
  // to its customer or its location. `is_primary` is computed here rather than
  // filtered so a single query covers both the primary and the general ones.
  const { rows: contactRows } = await db.query(
    `SELECT DISTINCT ON (c.id)
            c.id, c.first_name, c.last_name, c.phone, c.mobile, c.alternate_phone,
            c.email, c.type, c.types, c.contact_role,
            (c.id = $2) AS is_primary
     FROM contacts c
     LEFT JOIN contact_companies cc ON cc.contact_id = c.id
     LEFT JOIN contact_locations cl ON cl.contact_id = c.id
     WHERE c.company_id = $1
       AND (c.id = $2 OR cc.customer_id = $3 OR cl.location_id = $4)
     ORDER BY c.id`,
    [companyId, row.primary_contact_id, row.customer_id, row.location_id]
  );
  for (const c of contactRows) {
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null;
    contacts.push({
      id: c.id,
      source: "contact",
      role: c.is_primary ? "primary" : "general",
      contact_role: c.contact_role ?? "general",
      name,
      first_name: c.first_name ?? null,
      last_name: c.last_name ?? null,
      phone: c.phone ?? null,
      mobile: c.mobile ?? null,
      alternate_phone: c.alternate_phone ?? null,
      email: c.email ?? null,
      contact_type: c.type ?? null,
      contact_types: c.types ?? null,
    });
  }

  // Internal staff (job owner / salesperson) — same person may fill both.
  const staffRoles = [
    { id: row.owner_id, role: "job_owner" },
    { id: row.salesperson_id, role: "sales" },
  ].filter((s) => s.id);
  if (staffRoles.length) {
    const { rows: userRows } = await db.query(
      "SELECT id, name, email, status, is_tech, is_helper FROM crm_users WHERE company_id = $1 AND id = ANY($2::int[])",
      [companyId, staffRoles.map((s) => s.id)]
    );
    const byId = new Map(userRows.map((u) => [u.id, u]));
    for (const { id: userId, role } of staffRoles) {
      const u = byId.get(userId);
      if (!u) continue;
      contacts.push({
        id: u.id,
        source: "crm_user",
        role,
        contact_role: null,   // classification applies to customer contacts only
        name: u.name ?? null,
        first_name: null,
        last_name: null,
        phone: null,
        mobile: null,
        alternate_phone: null,
        email: u.email ?? null,
        contact_type: null,
        contact_types: null,
      });
    }
  }

  // primary → job_owner → sales → general, so the caller can just take the head.
  const rank = { primary: 0, job_owner: 1, sales: 2, general: 3 };
  contacts.sort((a, b) => (rank[a.role] ?? 9) - (rank[b.role] ?? 9));
  return contacts;
}

async function createJob(companyId, fields) {
  const {
    customer_id, technician_id, title, description, job_type, status,
    scheduled_date, scheduled_window_start, scheduled_window_end,
    external_ref, source, additional_information,
  } = fields;

  const result = await db.query(
    `INSERT INTO jobs
       (company_id, customer_id, technician_id, title, description, job_type, status,
        scheduled_date, scheduled_window_start, scheduled_window_end,
        external_ref, source, additional_information)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [
      companyId, customer_id, technician_id ?? null,
      title ?? null, description ?? null, job_type ?? null,
      status ?? "open",
      scheduled_date ?? null, scheduled_window_start ?? null, scheduled_window_end ?? null,
      external_ref ?? null, source ?? "manual",
      JSON.stringify(additional_information ?? {}),
    ]
  );
  return jobRow(result.rows[0]);
}

async function updateJob(id, companyId, fields) {
  const allowed = [
    "customer_id", "technician_id", "title", "description", "job_type", "status",
    "scheduled_date", "scheduled_window_start", "scheduled_window_end",
    "external_ref", "additional_information",
  ];
  const provided = Object.keys(fields).filter((k) => allowed.includes(k));
  if (provided.length === 0) return getJobById(id, companyId);

  // Auto-promote status to 'rescheduled' when the scheduled date/window changes,
  // unless the caller is explicitly setting a different status.
  const dateFields = ["scheduled_date", "scheduled_window_start", "scheduled_window_end"];
  const isDateChange = dateFields.some((f) => provided.includes(f));
  if (isDateChange && !provided.includes("status")) {
    fields = { ...fields, status: "rescheduled" };
    provided.push("status");
  }

  const setClauses = provided.map((k, idx) => `${k} = $${idx + 3}`).join(", ");
  const values = [
    id, companyId,
    ...provided.map((k) =>
      k === "additional_information" ? JSON.stringify(fields[k]) : fields[k]
    ),
  ];
  const result = await db.query(
    `UPDATE jobs SET ${setClauses}, updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    values
  );
  return result.rows[0] ? jobRow(result.rows[0]) : null;
}

// ── Appointments ──────────────────────────────────────────────────────────────

async function listAppointmentsByJob(jobId, companyId) {
  const result = await db.query(
    `SELECT a.*,
            t.first_name || ' ' || t.last_name AS technician_name,
            t.phone AS technician_phone
     FROM appointments a
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN technicians t ON t.id = a.technician_id
     WHERE a.job_id = $1 AND j.company_id = $2
     ORDER BY a.scheduled_start DESC`,
    [jobId, companyId]
  );
  return result.rows.map(apptRow);
}

async function createAppointment(companyId, jobId, fields) {
  const {
    technician_id, scheduled_start, scheduled_end,
    status, external_ref, source, additional_information,
  } = fields;

  const result = await db.query(
    `INSERT INTO appointments
       (company_id, job_id, technician_id, scheduled_start, scheduled_end,
        status, external_ref, source, additional_information)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [
      companyId, jobId, technician_id ?? null,
      scheduled_start, scheduled_end ?? null,
      status ?? "scheduled",
      external_ref ?? null, source ?? "manual",
      JSON.stringify(additional_information ?? {}),
    ]
  );
  return apptRow(result.rows[0]);
}

async function updateAppointment(id, companyId, fields) {
  const allowed = [
    "technician_id", "scheduled_start", "scheduled_end", "status",
    "customer_confirmed", "technician_confirmed",
    "customer_confirmed_at", "technician_confirmed_at",
    "reschedule_requested", "rescheduled_to",
    "cancellation_reason", "additional_information",
  ];
  const provided = Object.keys(fields).filter((k) => allowed.includes(k));
  if (provided.length === 0) return null;

  // Auto-promote status to 'rescheduled' when time changes, unless status is explicitly set
  const timeFields = ["scheduled_start", "scheduled_end"];
  const isTimeChange = timeFields.some((f) => provided.includes(f));
  if (isTimeChange && !provided.includes("status")) {
    fields = { ...fields, status: "rescheduled", reschedule_requested: true };
    if (!provided.includes("status")) provided.push("status");
    if (!provided.includes("reschedule_requested")) provided.push("reschedule_requested");
  }

  // Auto-set confirmed_at timestamps when confirmed flag is set
  const extra = [];
  if (fields.customer_confirmed === true && !fields.customer_confirmed_at) {
    extra.push(["customer_confirmed_at", new Date().toISOString()]);
  }
  if (fields.technician_confirmed === true && !fields.technician_confirmed_at) {
    extra.push(["technician_confirmed_at", new Date().toISOString()]);
  }

  const allFields = [...provided, ...extra.map(([k]) => k)];
  const allValues = [
    id, companyId,
    ...provided.map((k) =>
      k === "additional_information" ? JSON.stringify(fields[k]) : fields[k]
    ),
    ...extra.map(([, v]) => v),
  ];

  const setClauses = allFields.map((k, idx) => `${k} = $${idx + 3}`).join(", ");
  const result = await db.query(
    `UPDATE appointments SET ${setClauses}, updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    allValues
  );
  return result.rows[0] ? apptRow(result.rows[0]) : null;
}

/**
 * Confirm many appointments in one statement instead of looping
 * updateAppointment per row — for a recurring-service job with dozens of
 * future visits, a "confirm all remaining" action shouldn't cost one round
 * trip per appointment. customer_confirmed_at is stamped uniformly to the
 * time of the batch, same as updateAppointment's own auto-stamp behavior.
 */
async function bulkConfirmAppointments(companyId, appointmentIds) {
  if (!Array.isArray(appointmentIds) || appointmentIds.length === 0) return [];
  const result = await db.query(
    `UPDATE appointments SET customer_confirmed = true, customer_confirmed_at = NOW(), updated_at = NOW()
     WHERE company_id = $1 AND id = ANY($2::int[])
     RETURNING *`,
    [companyId, appointmentIds]
  );
  return result.rows.map(apptRow);
}

async function getAppointmentById(id, companyId) {
  const result = await db.query(
    `SELECT a.*,
            t.first_name || ' ' || t.last_name AS technician_name,
            t.phone AS technician_phone
     FROM appointments a
     JOIN jobs j ON j.id = a.job_id
     LEFT JOIN technicians t ON t.id = a.technician_id
     WHERE a.id = $1 AND j.company_id = $2`,
    [id, companyId]
  );
  return result.rows[0] ? apptRow(result.rows[0]) : null;
}

module.exports = {
  listJobs, listJobTypes, getJobById, createJob, updateJob, getJobContacts,
  fetchServicesByAppointment, fetchJobServiceLines,
  listAppointmentsByJob, createAppointment, updateAppointment, getAppointmentById,
  bulkConfirmAppointments,
};
