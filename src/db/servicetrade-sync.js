/**
 * ServiceTrade raw-data + sync-state DB layer.
 *
 * Mirrors the platform domain 1:1 — four raw tables (customers, jobs,
 * appointments, technicians) plus a sync_state cursor table.
 */
const db = require("./index");

const BATCH_SIZE = 500;

// ── Sync state ──────────────────────────────────────────────────────────────

const SYNC_STATE_COLUMNS = [
  "last_sync_at",
  "last_full_sync_at",
  "last_sync_status",
  "last_sync_error",
  "last_customers_created_at",
  "last_customers_updated_at",
  "last_jobs_created_at",
  "last_jobs_updated_at",
  "last_appointments_created_at",
  "last_appointments_updated_at",
  "last_technicians_created_at",
  "last_technicians_updated_at",
];

async function getSyncState(companyId) {
  const r = await db.query(
    `SELECT ${SYNC_STATE_COLUMNS.join(", ")} FROM servicetrade_sync_state WHERE company_id = $1`,
    [companyId]
  );
  return r.rows[0] || null;
}

async function updateSyncState(companyId, data) {
  const entries = Object.entries(data).filter(([k, v]) => SYNC_STATE_COLUMNS.includes(k) && v !== undefined);
  if (entries.length === 0) return;

  const cols  = entries.map(([k]) => k);
  const vals  = entries.map(([, v]) => v);
  const setClauses  = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  const insertCols  = ["company_id", ...cols].join(", ");
  const insertVals  = ["$1", ...cols.map((_, i) => `$${i + 2}`)].join(", ");

  await db.query(
    `INSERT INTO servicetrade_sync_state (${insertCols})
     VALUES (${insertVals})
     ON CONFLICT (company_id) DO UPDATE SET ${setClauses}`,
    [companyId, ...vals]
  );
}

// ── Upserts ─────────────────────────────────────────────────────────────────

async function upsertCustomersBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId, r.servicetrade_id,
        r.full_name ?? null, r.email ?? null, r.phone ?? null,
        r.address_line1 ?? null, r.city ?? null, r.state ?? null, r.zipcode ?? null,
        r.country ?? "US",
        r.is_active !== false,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_customers
         (company_id, servicetrade_id, full_name, email, phone,
          address_line1, city, state, zipcode, country, is_active, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         full_name     = EXCLUDED.full_name,
         email         = EXCLUDED.email,
         phone         = EXCLUDED.phone,
         address_line1 = EXCLUDED.address_line1,
         city          = EXCLUDED.city,
         state         = EXCLUDED.state,
         zipcode       = EXCLUDED.zipcode,
         country       = EXCLUDED.country,
         is_active     = EXCLUDED.is_active,
         payload       = EXCLUDED.payload,
         updated_at    = NOW()`,
      params
    );
  }
}

async function upsertJobsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId, r.servicetrade_id,
        r.servicetrade_customer_id ?? null,
        r.title ?? null, r.description ?? null,
        r.job_type ?? null, r.status ?? null,
        r.scheduled_date ?? null,
        r.scheduled_window_start ?? null, r.scheduled_window_end ?? null,
        r.is_active !== false,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_jobs
         (company_id, servicetrade_id, servicetrade_customer_id,
          title, description, job_type, status,
          scheduled_date, scheduled_window_start, scheduled_window_end,
          is_active, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         servicetrade_customer_id = EXCLUDED.servicetrade_customer_id,
         title                    = EXCLUDED.title,
         description              = EXCLUDED.description,
         job_type                 = EXCLUDED.job_type,
         status                   = EXCLUDED.status,
         scheduled_date           = EXCLUDED.scheduled_date,
         scheduled_window_start   = EXCLUDED.scheduled_window_start,
         scheduled_window_end     = EXCLUDED.scheduled_window_end,
         is_active                = EXCLUDED.is_active,
         payload                  = EXCLUDED.payload,
         updated_at               = NOW()`,
      params
    );
  }
}

async function upsertAppointmentsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId, r.servicetrade_id,
        r.servicetrade_job_id ?? null,
        r.servicetrade_technician_id ?? null,
        r.status ?? null,
        r.scheduled_start ?? null, r.scheduled_end ?? null,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_appointments
         (company_id, servicetrade_id, servicetrade_job_id, servicetrade_technician_id,
          status, scheduled_start, scheduled_end, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         servicetrade_job_id        = EXCLUDED.servicetrade_job_id,
         servicetrade_technician_id = EXCLUDED.servicetrade_technician_id,
         status                     = EXCLUDED.status,
         scheduled_start            = EXCLUDED.scheduled_start,
         scheduled_end              = EXCLUDED.scheduled_end,
         payload                    = EXCLUDED.payload,
         updated_at                 = NOW()`,
      params
    );
  }
}

async function upsertTechniciansBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId, r.servicetrade_id,
        r.first_name ?? null, r.last_name ?? null,
        r.email ?? null, r.phone ?? null,
        r.is_active !== false,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_technicians
         (company_id, servicetrade_id, first_name, last_name, email, phone, is_active, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name  = EXCLUDED.last_name,
         email      = EXCLUDED.email,
         phone      = EXCLUDED.phone,
         is_active  = EXCLUDED.is_active,
         payload    = EXCLUDED.payload,
         updated_at = NOW()`,
      params
    );
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

async function listCustomers(companyId, { includeInactive = false, page = 1, perPage = 50 } = {}) {
  const where = includeInactive ? "company_id = $1" : "company_id = $1 AND is_active = true";
  const offset = (page - 1) * perPage;
  const [rows, total] = await Promise.all([
    db.query(`SELECT * FROM servicetrade_customers WHERE ${where} ORDER BY id DESC LIMIT $2 OFFSET $3`, [companyId, perPage, offset]),
    db.query(`SELECT COUNT(*)::int AS n FROM servicetrade_customers WHERE ${where}`, [companyId]),
  ]);
  return { rows: rows.rows, total: total.rows[0].n };
}

async function listJobs(companyId, { page = 1, perPage = 50, customerId = null } = {}) {
  const conditions = ["company_id = $1"];
  const values = [companyId];
  let i = 2;
  if (customerId != null) { conditions.push(`servicetrade_customer_id = $${i++}`); values.push(customerId); }
  values.push(perPage, (page - 1) * perPage);
  const r = await db.query(
    `SELECT * FROM servicetrade_jobs WHERE ${conditions.join(" AND ")}
     ORDER BY scheduled_window_start DESC NULLS LAST, id DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return r.rows;
}

async function listAppointments(companyId, { jobId = null, page = 1, perPage = 50 } = {}) {
  const conditions = ["company_id = $1"];
  const values = [companyId];
  let i = 2;
  if (jobId != null) { conditions.push(`servicetrade_job_id = $${i++}`); values.push(jobId); }
  values.push(perPage, (page - 1) * perPage);
  const r = await db.query(
    `SELECT * FROM servicetrade_appointments WHERE ${conditions.join(" AND ")}
     ORDER BY scheduled_start DESC NULLS LAST, id DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return r.rows;
}

async function listTechnicians(companyId, { includeInactive = false } = {}) {
  const where = includeInactive ? "company_id = $1" : "company_id = $1 AND is_active = true";
  const r = await db.query(
    `SELECT * FROM servicetrade_technicians WHERE ${where} ORDER BY first_name, last_name`,
    [companyId]
  );
  return r.rows;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

async function deleteAllSyncData(companyId) {
  await db.query("DELETE FROM servicetrade_appointments WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_jobs         WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_customers    WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_technicians  WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_sync_state   WHERE company_id = $1", [companyId]);
}

module.exports = {
  // Sync state
  getSyncState,
  updateSyncState,
  // Upserts
  upsertCustomersBatch,
  upsertJobsBatch,
  upsertAppointmentsBatch,
  upsertTechniciansBatch,
  // Reads
  listCustomers,
  listJobs,
  listAppointments,
  listTechnicians,
  // Cleanup
  deleteAllSyncData,
};
