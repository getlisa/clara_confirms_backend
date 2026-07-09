const db = require("./index");

function jobRow(row) {
  return {
    id:                     row.id,
    company_id:             row.company_id,
    customer_id:            row.customer_id,
    technician_id:          row.technician_id ?? null,
    title:                  row.title ?? null,
    description:            row.description ?? null,
    job_type:               row.job_type ?? null,
    status:                 row.status,
    due_by:                  row.due_by ?? null,
    earliest_appointment_at: row.earliest_appointment_at ?? null,
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

async function listJobs(companyId, {
  status, jobType, customerId, technicianId,
  scheduledDateFrom, scheduledDateTo,
  dueSoonDays,
  search, limit = 50, offset = 0,
} = {}) {
  const conditions = ["j.company_id = $1"];
  const values = [companyId];
  let i = 2;

  if (status)          { conditions.push(`j.status = $${i++}`);          values.push(status); }
  if (jobType)         { conditions.push(`j.job_type = $${i++}`);         values.push(jobType); }
  if (customerId)      { conditions.push(`j.customer_id = $${i++}`);      values.push(customerId); }
  if (technicianId)    { conditions.push(`j.technician_id = $${i++}`);    values.push(technicianId); }
  if (scheduledDateFrom) { conditions.push(`j.due_by >= $${i++}`); values.push(scheduledDateFrom); }
  if (scheduledDateTo)   { conditions.push(`j.due_by <= $${i++}`); values.push(scheduledDateTo); }
  if (dueSoonDays != null) {
    // Jobs whose due_by falls between today and today + N days (inclusive)
    conditions.push(`j.due_by >= CURRENT_DATE AND j.due_by <= CURRENT_DATE + ($${i++} || ' days')::interval`);
    values.push(dueSoonDays);
  }
  if (search) {
    conditions.push(`(j.title ILIKE $${i} OR c.full_name ILIKE $${i})`);
    values.push(`%${search}%`);
    i++;
  }

  values.push(limit, offset);
  const result = await db.query(
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
     WHERE ${conditions.join(" AND ")}
     ORDER BY j.due_by ASC NULLS LAST, j.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return result.rows.map((row) => ({
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

  // Quotations for this job
  const quotes = await db.query(
    `SELECT id, quote_number, title, status, total_amount, currency, valid_until, created_at
     FROM quotations WHERE job_id = $1 ORDER BY created_at DESC`,
    [id]
  );
  job.quotations = quotes.rows;

  return job;
}

async function createJob(companyId, fields) {
  const {
    customer_id, technician_id, title, description, job_type, status,
    due_by,
    external_ref, source, additional_information,
  } = fields;

  const result = await db.query(
    `INSERT INTO jobs
       (company_id, customer_id, technician_id, title, description, job_type, status,
        due_by,
        external_ref, source, additional_information)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING *`,
    [
      companyId, customer_id, technician_id ?? null,
      title ?? null, description ?? null, job_type ?? null,
      status ?? "open",
      due_by ?? null,
      external_ref ?? null, source ?? "manual",
      JSON.stringify(additional_information ?? {}),
    ]
  );
  return jobRow(result.rows[0]);
}

async function updateJob(id, companyId, fields) {
  const allowed = [
    "customer_id", "technician_id", "title", "description", "job_type", "status",
    "due_by",
    "external_ref", "additional_information",
  ];
  const provided = Object.keys(fields).filter((k) => allowed.includes(k));
  if (provided.length === 0) return getJobById(id, companyId);

  // NOTE: jobs no longer own hard time. Changing due_by (a soft deadline) does NOT
  // reschedule anything — reschedule lives entirely on the appointment. Job status is
  // derived from its appointments (see src/services/lifecycle.js).

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

// Keep the derived cache jobs.earliest_appointment_at in sync with the job's
// earliest ACTIVE appointment. Called after any appointment insert/update.
async function recomputeJobEarliest(jobId) {
  await db.query(
    `UPDATE jobs j
        SET earliest_appointment_at = (
          SELECT MIN(a.scheduled_start) FROM appointments a
           WHERE a.job_id = j.id AND a.status NOT IN ('cancelled','rescheduled')
        )
      WHERE j.id = $1`,
    [jobId]
  );
}

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
  await recomputeJobEarliest(jobId);
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
  if (!result.rows[0]) return null;
  await recomputeJobEarliest(result.rows[0].job_id);
  return apptRow(result.rows[0]);
}

// Reschedule a job to a new date. Hard time lives on the appointment, so this
// moves the job's active appointment (preserving its time-of-day) when one exists;
// otherwise it just adjusts the soft deadline (due_by). `dateOnly` is 'YYYY-MM-DD'.
async function rescheduleJobToDate(jobId, companyId, dateOnly) {
  const appts = await listAppointmentsByJob(jobId, companyId);
  const active = appts.find((a) => !["cancelled", "rescheduled"].includes(a.status));
  if (active) {
    const prevIso = new Date(active.scheduled_start).toISOString();
    const newStart = `${dateOnly}T${prevIso.slice(11)}`; // keep time-of-day (UTC)
    await updateAppointment(active.id, companyId, { scheduled_start: newStart });
  } else {
    await updateJob(jobId, companyId, { due_by: dateOnly });
  }
  return getJobById(jobId, companyId);
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
  listJobs, getJobById, createJob, updateJob, rescheduleJobToDate,
  listAppointmentsByJob, createAppointment, updateAppointment, getAppointmentById,
};
