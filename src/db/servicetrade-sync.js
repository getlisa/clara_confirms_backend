/**
 * ServiceTrade sync tables: upserts and list queries.
 * All tables use (servicetrade_id, company_id) for idempotent upserts.
 * Batch upserts for sync performance.
 */

const db = require("./index");

const BATCH_SIZE = 500;

function normalizeAddressText(address) {
  if (address == null) return null;
  if (typeof address === "string") {
    const trimmed = address.trim();
    return trimmed !== "" ? trimmed : null;
  }
  try {
    return JSON.stringify(address);
  } catch (_) {
    return null;
  }
}

// ---------- Companies ----------
async function upsertCompany(companyId, row) {
  const {
    servicetrade_id,
    name,
    phone_number,
    address,
    is_active = true,
    is_deleted = false,
    payload,
  } = row;
  await db.query(
    `INSERT INTO servicetrade_companies (company_id, servicetrade_id, name, phone_number, address, is_active, is_deleted, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, NOW())
     ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
       name = EXCLUDED.name,
       phone_number = EXCLUDED.phone_number,
       address = EXCLUDED.address,
       is_active = EXCLUDED.is_active,
       is_deleted = EXCLUDED.is_deleted,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [
      companyId,
      servicetrade_id,
      name || null,
      phone_number || null,
      normalizeAddressText(address),
      is_active,
      is_deleted,
      payload ? JSON.stringify(payload) : null,
    ]
  );
}

/** Batch upsert companies. rows: array of { servicetrade_id, name, phone_number?, address?, is_active?, is_deleted?, payload? } */
async function upsertCompaniesBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId,
        r.servicetrade_id,
        r.name != null ? r.name : null,
        r.phone_number != null ? r.phone_number : null,
        normalizeAddressText(r.address),
        r.is_active !== false,
        r.is_deleted === true,
        r.payload ? JSON.stringify(r.payload) : null
      );
    });
    await db.query(
      `INSERT INTO servicetrade_companies (company_id, servicetrade_id, name, phone_number, address, is_active, is_deleted, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
         name = EXCLUDED.name,
         phone_number = EXCLUDED.phone_number,
         address = EXCLUDED.address,
         is_active = EXCLUDED.is_active,
         is_deleted = EXCLUDED.is_deleted,
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      params
    );
  }
}

// ---------- Locations ----------
async function upsertLocation(companyId, row, locationIdByStId) {
  const {
    servicetrade_id,
    servicetrade_company_id,
    name,
    phone_number,
    email,
    address,
    is_active = true,
    is_deleted = false,
    payload,
  } = row;
  await db.query(
    `INSERT INTO servicetrade_locations (company_id, servicetrade_id, servicetrade_company_id, name, phone_number, email, address, is_active, is_deleted, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
       servicetrade_company_id = EXCLUDED.servicetrade_company_id,
       name = EXCLUDED.name,
       phone_number = EXCLUDED.phone_number,
       email = EXCLUDED.email,
       address = EXCLUDED.address,
       is_active = EXCLUDED.is_active,
       is_deleted = EXCLUDED.is_deleted,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [
      companyId,
      servicetrade_id,
      servicetrade_company_id != null ? servicetrade_company_id : null,
      name || null,
      phone_number || null,
      email || null,
      address ? JSON.stringify(address) : null,
      is_active,
      is_deleted,
      payload ? JSON.stringify(payload) : null,
    ]
  );
  const r = await db.query(
    `SELECT id FROM servicetrade_locations WHERE company_id = $1 AND servicetrade_id = $2`,
    [companyId, servicetrade_id]
  );
  if (r.rows[0]) locationIdByStId.set(Number(servicetrade_id), r.rows[0].id);
}

/** Batch upsert locations. Returns Map<servicetrade_id, our_id>. rows: array of { servicetrade_id, servicetrade_company_id?, name, ... } */
async function upsertLocationsBatch(companyId, rows) {
  if (rows.length === 0) return new Map();
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId,
        r.servicetrade_id,
        r.servicetrade_company_id != null ? r.servicetrade_company_id : null,
        r.name != null ? r.name : null,
        r.phone_number != null ? r.phone_number : null,
        r.email != null ? r.email : null,
        r.address ? JSON.stringify(r.address) : null,
        r.is_active !== false,
        r.is_deleted === true,
        r.payload ? JSON.stringify(r.payload) : null
      );
    });
    await db.query(
      `INSERT INTO servicetrade_locations (company_id, servicetrade_id, servicetrade_company_id, name, phone_number, email, address, is_active, is_deleted, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
         servicetrade_company_id = EXCLUDED.servicetrade_company_id,
         name = EXCLUDED.name,
         phone_number = EXCLUDED.phone_number,
         email = EXCLUDED.email,
         address = EXCLUDED.address,
         is_active = EXCLUDED.is_active,
         is_deleted = EXCLUDED.is_deleted,
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      params
    );
  }
  const r = await db.query(
    `SELECT id, servicetrade_id FROM servicetrade_locations WHERE company_id = $1`,
    [companyId]
  );
  const map = new Map();
  r.rows.forEach((row) => map.set(Number(row.servicetrade_id), row.id));
  return map;
}

// ---------- Service requests ----------
async function upsertServiceRequest(companyId, row) {
  const {
    servicetrade_id,
    location_id,
    job_id,
    asset_id,
    description,
    status,
    window_start,
    window_end,
    payload,
  } = row;
  await db.query(
    `INSERT INTO servicetrade_service_requests (company_id, servicetrade_id, location_id, job_id, asset_id, description, status, window_start, window_end, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
       location_id = EXCLUDED.location_id,
       job_id = EXCLUDED.job_id,
       asset_id = EXCLUDED.asset_id,
       description = EXCLUDED.description,
       status = EXCLUDED.status,
       window_start = EXCLUDED.window_start,
       window_end = EXCLUDED.window_end,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [
      companyId,
      servicetrade_id,
      location_id,
      job_id || null,
      asset_id || null,
      description || null,
      status || null,
      window_start || null,
      window_end || null,
      payload ? JSON.stringify(payload) : null,
    ]
  );
}

/** Batch upsert service requests. rows: array of { servicetrade_id, location_id, job_id?, asset_id?, description?, status?, window_start?, window_end?, payload? } */
async function upsertServiceRequestsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId,
        r.servicetrade_id,
        r.location_id,
        r.job_id != null ? r.job_id : null,
        r.asset_id != null ? r.asset_id : null,
        r.description != null ? r.description : null,
        r.status != null ? r.status : null,
        r.window_start != null ? r.window_start : null,
        r.window_end != null ? r.window_end : null,
        r.payload ? JSON.stringify(r.payload) : null
      );
    });
    await db.query(
      `INSERT INTO servicetrade_service_requests (company_id, servicetrade_id, location_id, job_id, asset_id, description, status, window_start, window_end, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
         location_id = EXCLUDED.location_id,
         job_id = EXCLUDED.job_id,
         asset_id = EXCLUDED.asset_id,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         window_start = EXCLUDED.window_start,
         window_end = EXCLUDED.window_end,
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      params
    );
  }
}

// ---------- Contacts ----------
async function upsertContact(companyId, row) {
  const {
    servicetrade_id,
    first_name,
    last_name,
    phone,
    mobile,
    email,
    type,
    location_id,
    payload,
  } = row;
  await db.query(
    `INSERT INTO servicetrade_contacts (company_id, servicetrade_id, first_name, last_name, phone, mobile, email, type, location_id, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NOW())
     ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
       first_name = EXCLUDED.first_name,
       last_name = EXCLUDED.last_name,
       phone = EXCLUDED.phone,
       mobile = EXCLUDED.mobile,
       email = EXCLUDED.email,
       type = EXCLUDED.type,
       location_id = EXCLUDED.location_id,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [
      companyId,
      servicetrade_id,
      first_name || null,
      last_name || null,
      phone || null,
      mobile || null,
      email || null,
      type || null,
      location_id || null,
      payload ? JSON.stringify(payload) : null,
    ]
  );
}

/** Batch upsert contacts. */
async function upsertContactsBatch(companyId, rows) {
  if (rows.length === 0) return;
  // De-duplicate by servicetrade_id so one INSERT statement never tries to
  // affect the same conflict key multiple times.
  const dedupedMap = new Map();
  rows.forEach((row) => {
    if (!row || row.servicetrade_id == null) return;
    const key = Number(row.servicetrade_id);
    const prev = dedupedMap.get(key);
    if (!prev) {
      dedupedMap.set(key, row);
      return;
    }
    dedupedMap.set(key, {
      ...prev,
      ...row,
      location_id: row.location_id != null ? row.location_id : prev.location_id,
      linked_location_ids: Array.from(
        new Set([...(prev.linked_location_ids || []), ...(row.linked_location_ids || [])])
      ),
      linked_servicetrade_company_ids: Array.from(
        new Set([
          ...(prev.linked_servicetrade_company_ids || []),
          ...(row.linked_servicetrade_company_ids || []),
        ])
      ),
      payload: row.payload != null ? row.payload : prev.payload,
    });
  });

  const dedupedRows = Array.from(dedupedMap.values());
  for (let i = 0; i < dedupedRows.length; i += BATCH_SIZE) {
    const chunk = dedupedRows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId,
        r.servicetrade_id,
        r.first_name != null ? r.first_name : null,
        r.last_name != null ? r.last_name : null,
        r.phone != null ? r.phone : null,
        r.mobile != null ? r.mobile : null,
        r.email != null ? r.email : null,
        r.type != null ? r.type : null,
        r.location_id != null ? r.location_id : null,
        r.payload ? JSON.stringify(r.payload) : null
      );
    });
    await db.query(
      `INSERT INTO servicetrade_contacts (company_id, servicetrade_id, first_name, last_name, phone, mobile, email, type, location_id, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         phone = EXCLUDED.phone,
         mobile = EXCLUDED.mobile,
         email = EXCLUDED.email,
         type = EXCLUDED.type,
         location_id = EXCLUDED.location_id,
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      params
    );
  }
}

async function replaceContactLocationLinks(companyId, rows) {
  await db.query("DELETE FROM servicetrade_contact_locations WHERE company_id = $1", [companyId]);
  if (!Array.isArray(rows) || rows.length === 0) return;

  const deduped = new Map();
  rows.forEach((row) => {
    if (!row || row.contact_id == null || row.location_id == null) return;
    deduped.set(`${row.contact_id}:${row.location_id}`, row);
  });

  const valuesRows = Array.from(deduped.values());
  for (let i = 0; i < valuesRows.length; i += BATCH_SIZE) {
    const chunk = valuesRows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let idx = 0;
    chunk.forEach((row) => {
      values.push(`($${++idx}, $${++idx}, $${++idx}, NOW(), NOW())`);
      params.push(companyId, row.contact_id, row.location_id);
    });
    await db.query(
      `INSERT INTO servicetrade_contact_locations (company_id, contact_id, location_id, created_at, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (contact_id, location_id) DO UPDATE SET
         updated_at = NOW()`,
      params
    );
  }
}

async function replaceContactCompanyLinks(companyId, rows) {
  await db.query("DELETE FROM servicetrade_contact_companies WHERE company_id = $1", [companyId]);
  if (!Array.isArray(rows) || rows.length === 0) return;

  const deduped = new Map();
  rows.forEach((row) => {
    if (!row || row.contact_id == null || row.servicetrade_company_id == null) return;
    deduped.set(`${row.contact_id}:${row.servicetrade_company_id}`, row);
  });

  const valuesRows = Array.from(deduped.values());
  for (let i = 0; i < valuesRows.length; i += BATCH_SIZE) {
    const chunk = valuesRows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let idx = 0;
    chunk.forEach((row) => {
      values.push(`($${++idx}, $${++idx}, $${++idx}, NOW(), NOW())`);
      params.push(companyId, row.contact_id, row.servicetrade_company_id);
    });
    await db.query(
      `INSERT INTO servicetrade_contact_companies (company_id, contact_id, servicetrade_company_id, created_at, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (contact_id, servicetrade_company_id) DO UPDATE SET
         updated_at = NOW()`,
      params
    );
  }
}

// ---------- Assets ----------
async function upsertAsset(companyId, row) {
  const { servicetrade_id, location_id, service_request_id, name, payload } = row;
  await db.query(
    `INSERT INTO servicetrade_assets (company_id, servicetrade_id, location_id, service_request_id, name, payload, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
     ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
       location_id = EXCLUDED.location_id,
       service_request_id = EXCLUDED.service_request_id,
       name = EXCLUDED.name,
       payload = EXCLUDED.payload,
       updated_at = NOW()`,
    [
      companyId,
      servicetrade_id,
      location_id,
      service_request_id || null,
      name || null,
      payload ? JSON.stringify(payload) : null,
    ]
  );
}

/** Batch upsert assets. */
async function upsertAssetsBatch(companyId, rows) {
  if (rows.length === 0) return;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];
    let idx = 0;
    chunk.forEach((r) => {
      values.push(
        `($${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}, $${++idx}::jsonb, NOW())`
      );
      params.push(
        companyId,
        r.servicetrade_id,
        r.location_id,
        r.service_request_id != null ? r.service_request_id : null,
        r.name != null ? r.name : null,
        r.payload ? JSON.stringify(r.payload) : null
      );
    });
    await db.query(
      `INSERT INTO servicetrade_assets (company_id, servicetrade_id, location_id, service_request_id, name, payload, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (servicetrade_id, company_id) DO UPDATE SET
         location_id = EXCLUDED.location_id,
         service_request_id = EXCLUDED.service_request_id,
         name = EXCLUDED.name,
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      params
    );
  }
}

// ---------- Delete all sync data (for company) ----------
async function deleteAllSyncData(companyId) {
  await db.query("DELETE FROM servicetrade_contact_locations WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_contact_companies WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_assets WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_contacts WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_service_requests WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_locations WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_companies WHERE company_id = $1", [companyId]);
  await db.query("DELETE FROM servicetrade_sync_state WHERE company_id = $1", [companyId]);
}

// ---------- Sync state ----------
async function getLastSyncAt(companyId) {
  const r = await db.query(
    `SELECT last_sync_at FROM servicetrade_sync_state WHERE company_id = $1`,
    [companyId]
  );
  return r.rows[0] ? Number(r.rows[0].last_sync_at) : null;
}

async function setLastSyncAt(companyId, lastSyncAtUnixSeconds) {
  await db.query(
    `INSERT INTO servicetrade_sync_state (company_id, last_sync_at)
     VALUES ($1, $2)
     ON CONFLICT (company_id) DO UPDATE SET last_sync_at = EXCLUDED.last_sync_at`,
    [companyId, lastSyncAtUnixSeconds]
  );
}

// ---------- Recompute is_active ----------
/** Set location is_active = true iff it has at least one SR with status in (open, in_progress, pending). */
async function recomputeLocationIsActive(companyId) {
  await db.query(
    `UPDATE servicetrade_locations l
     SET is_active = EXISTS (
       SELECT 1 FROM servicetrade_service_requests sr
       WHERE sr.location_id = l.id AND sr.status IN ('open', 'in_progress', 'pending')
     ),
     is_deleted = FALSE
     WHERE l.company_id = $1`,
    [companyId]
  );
}

/** Set company (ST) is_active = true iff it has at least one location with is_active = true. */
async function recomputeCompanyIsActive(companyId) {
  await db.query(
    `UPDATE servicetrade_companies c
     SET is_active = EXISTS (
       SELECT 1 FROM servicetrade_locations l
       WHERE l.company_id = c.company_id AND l.servicetrade_company_id = c.servicetrade_id AND l.is_active = TRUE
     ),
     is_deleted = FALSE
     WHERE c.company_id = $1`,
    [companyId]
  );
}

// ---------- List APIs for UI ----------
async function listCompanies(companyId, includeInactive = false, page = 1, perPage = 50) {
  const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const safePerPage = Number.isFinite(perPage) && perPage > 0 ? Math.min(Math.floor(perPage), 200) : 50;
  const offset = (safePage - 1) * safePerPage;
  const where = includeInactive
    ? `company_id = $1`
    : `company_id = $1 AND is_deleted = FALSE AND is_active = TRUE`;

  const rowsResult = await db.query(
    `SELECT id, servicetrade_id, name, phone_number, address, is_active, is_deleted
     FROM servicetrade_companies
     WHERE ${where}
     ORDER BY name
     LIMIT $2 OFFSET $3`,
    [companyId, safePerPage, offset]
  );

  const countResult = await db.query(
    `SELECT COUNT(*)::int AS total
     FROM servicetrade_companies
     WHERE ${where}`,
    [companyId]
  );

  return {
    rows: rowsResult.rows,
    total: countResult.rows[0] ? Number(countResult.rows[0].total) : 0,
    page: safePage,
    perPage: safePerPage,
  };
}

async function countLocationsByStCompanyBulk(companyId, servicetradeCompanyIds) {
  if (!Array.isArray(servicetradeCompanyIds) || servicetradeCompanyIds.length === 0) {
    return new Map();
  }
  const r = await db.query(
    `SELECT servicetrade_company_id, COUNT(*)::int AS count
     FROM servicetrade_locations
     WHERE company_id = $1 AND servicetrade_company_id = ANY($2::bigint[])
     GROUP BY servicetrade_company_id`,
    [companyId, servicetradeCompanyIds]
  );
  const map = new Map();
  r.rows.forEach((row) => map.set(Number(row.servicetrade_company_id), Number(row.count)));
  return map;
}

async function listLocationsByStCompany(companyId, servicetradeCompanyId, includeInactive = false) {
  const q = includeInactive
    ? `SELECT id, servicetrade_id, name, phone_number, email, address, is_active FROM servicetrade_locations WHERE company_id = $1 AND servicetrade_company_id = $2 ORDER BY name`
    : `SELECT id, servicetrade_id, name, phone_number, email, address, is_active FROM servicetrade_locations WHERE company_id = $1 AND servicetrade_company_id = $2 AND is_deleted = FALSE AND is_active = TRUE ORDER BY name`;
  const r = await db.query(q, [companyId, servicetradeCompanyId]);
  return r.rows;
}

async function countServiceRequestsByLocationBulk(locationIds) {
  if (!Array.isArray(locationIds) || locationIds.length === 0) {
    return new Map();
  }
  const r = await db.query(
    `SELECT location_id, COUNT(*)::int AS count
     FROM servicetrade_service_requests
     WHERE location_id = ANY($1::bigint[])
     GROUP BY location_id`,
    [locationIds]
  );
  const map = new Map();
  r.rows.forEach((row) => map.set(Number(row.location_id), Number(row.count)));
  return map;
}

async function listServiceRequestsByLocation(companyId, locationId) {
  const r = await db.query(
    `SELECT sr.id, sr.servicetrade_id, sr.description, sr.status, sr.window_start, sr.window_end, sr.job_id,
      (SELECT a.name FROM servicetrade_assets a WHERE a.service_request_id = sr.id LIMIT 1) AS asset_name
     FROM servicetrade_service_requests sr
     WHERE sr.company_id = $1 AND sr.location_id = $2
     ORDER BY sr.window_start NULLS LAST, sr.id`,
    [companyId, locationId]
  );
  return r.rows;
}

async function listContactsByLocation(companyId, locationId) {
  const r = await db.query(
    `SELECT DISTINCT c.id, c.servicetrade_id, c.first_name, c.last_name, c.phone, c.mobile, c.email, c.type
     FROM servicetrade_contacts c
     JOIN servicetrade_contact_locations cl ON cl.contact_id = c.id
     WHERE c.company_id = $1 AND cl.location_id = $2
     ORDER BY c.last_name, c.first_name`,
    [companyId, locationId]
  );
  return r.rows;
}

async function listAssetsByLocation(companyId, locationId) {
  const r = await db.query(
    `SELECT a.id, a.servicetrade_id, a.name, sr.description AS service_request_description
     FROM servicetrade_assets a
     LEFT JOIN servicetrade_service_requests sr ON sr.id = a.service_request_id
     WHERE a.company_id = $1 AND a.location_id = $2 ORDER BY a.name`,
    [companyId, locationId]
  );
  return r.rows;
}

async function getLocationById(companyId, locationId) {
  const r = await db.query(
    `SELECT id, servicetrade_id, servicetrade_company_id, name, phone_number, email, address, is_active
     FROM servicetrade_locations WHERE company_id = $1 AND id = $2`,
    [companyId, locationId]
  );
  return r.rows[0] || null;
}

async function getStCompanyById(companyId, servicetradeCompanyId) {
  const r = await db.query(
    `SELECT id, servicetrade_id, name, phone_number, address, is_active FROM servicetrade_companies WHERE company_id = $1 AND servicetrade_id = $2`,
    [companyId, servicetradeCompanyId]
  );
  return r.rows[0] || null;
}

module.exports = {
  upsertCompany,
  upsertLocation,
  upsertServiceRequest,
  upsertContact,
  upsertAsset,
  upsertCompaniesBatch,
  upsertLocationsBatch,
  upsertServiceRequestsBatch,
  upsertContactsBatch,
  replaceContactLocationLinks,
  replaceContactCompanyLinks,
  upsertAssetsBatch,
  deleteAllSyncData,
  getLastSyncAt,
  setLastSyncAt,
  recomputeLocationIsActive,
  recomputeCompanyIsActive,
  listCompanies,
  countLocationsByStCompanyBulk,
  listLocationsByStCompany,
  countServiceRequestsByLocationBulk,
  listServiceRequestsByLocation,
  listContactsByLocation,
  listAssetsByLocation,
  getLocationById,
  getStCompanyById,
};
