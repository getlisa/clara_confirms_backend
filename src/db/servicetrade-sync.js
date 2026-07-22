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
  "last_locations_created_at",
  "last_locations_updated_at",
  "last_service_requests_created_at",
  "last_service_requests_updated_at",
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

async function upsertLocationsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, $${++idx}::jsonb, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId, r.servicetrade_id, r.servicetrade_customer_id ?? null, r.servicetrade_primary_contact_id ?? null,
        r.name ?? null, r.lat ?? null, r.lon ?? null, r.phone ?? null, r.email ?? null,
        r.general_manager_name ?? null,
        r.address_line1 ?? null, r.city ?? null, r.state ?? null, r.zipcode ?? null, r.country ?? "US",
        r.company ? JSON.stringify(r.company) : null,
        r.brand ? JSON.stringify(r.brand) : null,
        r.taxable ?? null,
        r.status ?? null,
        r.is_active !== false,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_locations
         (company_id, servicetrade_id, servicetrade_customer_id, servicetrade_primary_contact_id,
          name, lat, lon, phone, email, general_manager_name,
          address_line1, city, state, zipcode, country,
          company, brand, taxable, status, is_active, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         servicetrade_customer_id        = EXCLUDED.servicetrade_customer_id,
         servicetrade_primary_contact_id = EXCLUDED.servicetrade_primary_contact_id,
         name                 = EXCLUDED.name,
         lat                  = EXCLUDED.lat,
         lon                  = EXCLUDED.lon,
         phone                = EXCLUDED.phone,
         email                = EXCLUDED.email,
         general_manager_name = EXCLUDED.general_manager_name,
         address_line1        = EXCLUDED.address_line1,
         city                 = EXCLUDED.city,
         state                = EXCLUDED.state,
         zipcode              = EXCLUDED.zipcode,
         country              = EXCLUDED.country,
         company              = EXCLUDED.company,
         brand                = EXCLUDED.brand,
         taxable              = EXCLUDED.taxable,
         status               = EXCLUDED.status,
         payload              = EXCLUDED.payload,
         is_active            = EXCLUDED.is_active,
         updated_at           = NOW()`,
      params
    );
  }
}

async function upsertContactsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, $${++idx}::jsonb, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId, r.servicetrade_id,
        r.first_name ?? null, r.last_name ?? null,
        r.phone ?? null, r.mobile ?? null, r.alternate_phone ?? null, r.email ?? null, r.type ?? null,
        r.status ?? null,
        r.types ? JSON.stringify(r.types) : null,
        r.external_ids ? JSON.stringify(r.external_ids) : null,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_contacts
         (company_id, servicetrade_id, first_name, last_name, phone, mobile, alternate_phone, email, type,
          status, types, external_ids, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         first_name      = EXCLUDED.first_name,
         last_name       = EXCLUDED.last_name,
         phone           = EXCLUDED.phone,
         mobile          = EXCLUDED.mobile,
         alternate_phone = EXCLUDED.alternate_phone,
         email           = EXCLUDED.email,
         type            = EXCLUDED.type,
         status          = EXCLUDED.status,
         types           = EXCLUDED.types,
         external_ids    = EXCLUDED.external_ids,
         payload         = EXCLUDED.payload,
         updated_at      = NOW()`,
      params
    );
  }
}

async function upsertOfficesBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId, r.servicetrade_id,
        r.name ?? null,
        r.address_line1 ?? null, r.city ?? null, r.state ?? null, r.zipcode ?? null, r.country ?? "US",
        r.lat ?? null, r.lon ?? null, r.phone ?? null, r.email ?? null,
        r.is_active !== false,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_offices
         (company_id, servicetrade_id, name, address_line1, city, state, zipcode, country,
          lat, lon, phone, email, is_active, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         name          = EXCLUDED.name,
         address_line1 = EXCLUDED.address_line1,
         city          = EXCLUDED.city,
         state         = EXCLUDED.state,
         zipcode       = EXCLUDED.zipcode,
         country       = EXCLUDED.country,
         lat           = EXCLUDED.lat,
         lon           = EXCLUDED.lon,
         phone         = EXCLUDED.phone,
         email         = EXCLUDED.email,
         is_active     = EXCLUDED.is_active,
         payload       = EXCLUDED.payload,
         updated_at    = NOW()`,
      params
    );
  }
}

async function upsertTagsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(`($${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`);
      params.push(companyId, r.servicetrade_id, r.name ?? null, r.payload ? JSON.stringify(r.payload) : "{}");
    });
    await db.query(
      `INSERT INTO servicetrade_tags (company_id, servicetrade_id, name, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         name       = EXCLUDED.name,
         payload    = EXCLUDED.payload,
         updated_at = NOW()`,
      params
    );
  }
}

async function upsertServiceLinesBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(`($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`);
      params.push(companyId, r.servicetrade_id, r.name ?? null, r.trade ?? null, r.abbr ?? null, r.payload ? JSON.stringify(r.payload) : "{}");
    });
    await db.query(
      `INSERT INTO servicetrade_service_lines (company_id, servicetrade_id, name, trade, abbr, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         name = EXCLUDED.name, trade = EXCLUDED.trade, abbr = EXCLUDED.abbr,
         payload = EXCLUDED.payload, updated_at = NOW()`,
      params
    );
  }
}

async function upsertDeficienciesBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(`($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`);
      params.push(companyId, r.servicetrade_id, r.ref_number ?? null, r.name ?? null, r.description ?? null, r.payload ? JSON.stringify(r.payload) : "{}");
    });
    await db.query(
      `INSERT INTO servicetrade_deficiencies (company_id, servicetrade_id, ref_number, name, description, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         ref_number = EXCLUDED.ref_number, name = EXCLUDED.name, description = EXCLUDED.description,
         payload = EXCLUDED.payload, updated_at = NOW()`,
      params
    );
  }
}

async function upsertChangeOrdersBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(`($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`);
      params.push(companyId, r.servicetrade_id, r.status ?? null, r.type ?? null, r.reference_number ?? null, r.payload ? JSON.stringify(r.payload) : "{}");
    });
    await db.query(
      `INSERT INTO servicetrade_change_orders (company_id, servicetrade_id, status, type, reference_number, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         status = EXCLUDED.status, type = EXCLUDED.type, reference_number = EXCLUDED.reference_number,
         payload = EXCLUDED.payload, updated_at = NOW()`,
      params
    );
  }
}

async function upsertContractsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(`($${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`);
      params.push(companyId, r.servicetrade_id, r.name ?? null, r.payload ? JSON.stringify(r.payload) : "{}");
    });
    await db.query(
      `INSERT INTO servicetrade_contracts (company_id, servicetrade_id, name, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         name = EXCLUDED.name, payload = EXCLUDED.payload, updated_at = NOW()`,
      params
    );
  }
}

async function upsertServiceRecurrencesBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(`($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`);
      params.push(
        companyId, r.servicetrade_id, r.description ?? null, r.frequency ?? null,
        r.recurrence_interval ?? null, r.repeat_weekday ?? null,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_service_recurrences
         (company_id, servicetrade_id, description, frequency, recurrence_interval, repeat_weekday, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         description = EXCLUDED.description, frequency = EXCLUDED.frequency,
         recurrence_interval = EXCLUDED.recurrence_interval, repeat_weekday = EXCLUDED.repeat_weekday,
         payload = EXCLUDED.payload, updated_at = NOW()`,
      params
    );
  }
}

async function upsertServiceRequestsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, $${++idx}::jsonb, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, $${++idx}::jsonb, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId, r.servicetrade_id, r.status ?? null, r.completion ?? null, r.description ?? null,
        r.servicetrade_service_line_id ?? null, r.servicetrade_job_id ?? null, r.servicetrade_appointment_id ?? null,
        r.servicetrade_deficiency_id ?? null, r.servicetrade_change_order_id ?? null,
        r.servicetrade_contract_id ?? null, r.servicetrade_location_id ?? null, r.servicetrade_recurrence_id ?? null,
        r.asset ? JSON.stringify(r.asset) : null,
        r.budget ? JSON.stringify(r.budget) : null,
        r.window_start ?? null, r.window_end ?? null, r.closed_on ?? null,
        r.estimated_price ?? null, r.duration ?? null, r.preferred_start_time ?? null,
        r.preferred_vendor ? JSON.stringify(r.preferred_vendor) : null,
        r.visibility ? JSON.stringify(r.visibility) : null,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_service_requests
         (company_id, servicetrade_id, status, completion, description,
          servicetrade_service_line_id, servicetrade_job_id, servicetrade_appointment_id, servicetrade_deficiency_id,
          servicetrade_change_order_id, servicetrade_contract_id, servicetrade_location_id, servicetrade_recurrence_id,
          asset, budget, window_start, window_end, closed_on,
          estimated_price, duration, preferred_start_time, preferred_vendor, visibility, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO UPDATE SET
         status                       = EXCLUDED.status,
         completion                   = COALESCE(EXCLUDED.completion, servicetrade_service_requests.completion),
         description                  = EXCLUDED.description,
         servicetrade_service_line_id = EXCLUDED.servicetrade_service_line_id,
         servicetrade_job_id          = EXCLUDED.servicetrade_job_id,
         -- Two sync paths write this row: the /servicerequest list (never sets
         -- an appointment) and the /appointment/{id} detail fetch (always sets
         -- one). Whichever runs last must not clobber a known appointment link
         -- back to null.
         servicetrade_appointment_id  = COALESCE(EXCLUDED.servicetrade_appointment_id, servicetrade_service_requests.servicetrade_appointment_id),
         servicetrade_deficiency_id   = EXCLUDED.servicetrade_deficiency_id,
         servicetrade_change_order_id = EXCLUDED.servicetrade_change_order_id,
         servicetrade_contract_id     = EXCLUDED.servicetrade_contract_id,
         servicetrade_location_id     = EXCLUDED.servicetrade_location_id,
         servicetrade_recurrence_id   = EXCLUDED.servicetrade_recurrence_id,
         asset                        = EXCLUDED.asset,
         budget                       = EXCLUDED.budget,
         window_start                 = EXCLUDED.window_start,
         window_end                   = EXCLUDED.window_end,
         closed_on                    = EXCLUDED.closed_on,
         estimated_price              = EXCLUDED.estimated_price,
         duration                     = EXCLUDED.duration,
         preferred_start_time         = EXCLUDED.preferred_start_time,
         preferred_vendor             = EXCLUDED.preferred_vendor,
         visibility                   = EXCLUDED.visibility,
         payload                      = EXCLUDED.payload,
         updated_at                   = NOW()`,
      params
    );
  }
}

/** Insert-only (never overwrite) — guarantees FK-resolvability for a job referenced by a service request but not yet seen by the dedicated /job sync. */
async function upsertJobStubsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(`($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb)`);
      params.push(companyId, r.servicetrade_id, r.title ?? null, r.job_type ?? null, r.payload ? JSON.stringify(r.payload) : "{}");
    });
    await db.query(
      `INSERT INTO servicetrade_jobs (company_id, servicetrade_id, title, job_type, payload)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO NOTHING`,
      params
    );
  }
}

/** Insert-only (never overwrite) — guarantees FK-resolvability for a location referenced by a service request but not covered by /location's isCustomer=true&status=active filter. */
async function upsertLocationStubsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const values = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb)`
      );
      params.push(
        companyId, r.servicetrade_id, r.name ?? null, r.lat ?? null, r.lon ?? null,
        r.phone ?? null, r.email ?? null, r.general_manager_name ?? null,
        r.address_line1 ?? null, r.city ?? null, r.state ?? null, r.zipcode ?? null, r.country ?? "US",
        r.taxable ?? null, r.status ?? null,
        r.payload ? JSON.stringify(r.payload) : "{}"
      );
    });
    await db.query(
      `INSERT INTO servicetrade_locations
         (company_id, servicetrade_id, name, lat, lon, phone, email, general_manager_name,
          address_line1, city, state, zipcode, country, taxable, status, payload)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, servicetrade_id) DO NOTHING`,
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

async function listLocations(companyId, { includeInactive = false, page = 1, perPage = 50 } = {}) {
  const where = includeInactive ? "company_id = $1" : "company_id = $1 AND is_active = true";
  const offset = (page - 1) * perPage;
  const [rows, total] = await Promise.all([
    db.query(`SELECT * FROM servicetrade_locations WHERE ${where} ORDER BY id DESC LIMIT $2 OFFSET $3`, [companyId, perPage, offset]),
    db.query(`SELECT COUNT(*)::int AS n FROM servicetrade_locations WHERE ${where}`, [companyId]),
  ]);
  return { rows: rows.rows, total: total.rows[0].n };
}

async function listContacts(companyId) {
  const r = await db.query(`SELECT * FROM servicetrade_contacts WHERE company_id = $1 ORDER BY id DESC`, [companyId]);
  return r.rows;
}

async function listOffices(companyId, { includeInactive = false } = {}) {
  const where = includeInactive ? "company_id = $1" : "company_id = $1 AND is_active = true";
  const r = await db.query(`SELECT * FROM servicetrade_offices WHERE ${where} ORDER BY name`, [companyId]);
  return r.rows;
}

async function listTags(companyId) {
  const r = await db.query(`SELECT * FROM servicetrade_tags WHERE company_id = $1 ORDER BY name`, [companyId]);
  return r.rows;
}

async function listServiceRequests(companyId, { status = null, page = 1, perPage = 50 } = {}) {
  const conditions = ["company_id = $1"];
  const values = [companyId];
  let i = 2;
  if (status) { conditions.push(`status = $${i++}`); values.push(status); }
  values.push(perPage, (page - 1) * perPage);
  const r = await db.query(
    `SELECT * FROM servicetrade_service_requests WHERE ${conditions.join(" AND ")}
     ORDER BY window_start DESC NULLS LAST, id DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return r.rows;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

async function deleteAllSyncData(companyId) {
  await db.query("DELETE FROM servicetrade_service_requests    WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_service_recurrences WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_contracts           WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_change_orders       WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_deficiencies        WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_service_lines       WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_appointments WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_jobs         WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_locations    WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_offices      WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_contacts     WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_tags         WHERE company_id = $1", [companyId]);
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
  upsertLocationsBatch,
  upsertContactsBatch,
  upsertOfficesBatch,
  upsertTagsBatch,
  upsertServiceLinesBatch,
  upsertDeficienciesBatch,
  upsertChangeOrdersBatch,
  upsertContractsBatch,
  upsertServiceRecurrencesBatch,
  upsertServiceRequestsBatch,
  upsertJobStubsBatch,
  upsertLocationStubsBatch,
  // Reads
  listCustomers,
  listJobs,
  listAppointments,
  listTechnicians,
  listLocations,
  listContacts,
  listOffices,
  listTags,
  listServiceRequests,
  // Cleanup
  deleteAllSyncData,
};
