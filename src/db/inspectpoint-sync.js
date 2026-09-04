/**
 * InspectPoint raw-data + sync-state DB layer.
 *
 * Unlike db/servicetrade-sync.js (one hand-written upsert function per raw
 * table, each duplicating every scalar field into a typed column), InspectPoint's
 * six raw tables are deliberately slim — company_id/inspectpoint_id plus a
 * handful of soft-FK/status/date columns, everything else in `payload` — so
 * one generic upsert covers all six. See migrations/104_inspectpoint_raw_tables.sql
 * for why the shape differs from ServiceTrade's.
 */
const db = require("./index");
const logger = require("../utils/logger");

// Same reasoning as ServiceTrade's BATCH_SIZE (db/servicetrade-sync.js): every
// row carries a JSONB payload, so batch size is really "how many kB per round
// trip" on a remote pooled connection.
const BATCH_SIZE = 50;

// ── Sync state ────────────────────────────────────────────────────────────────
//
// Simpler than ServiceTrade's: the whole table ships in one migration (104),
// so there's no OPTIONAL_SYNC_STATE_COLUMNS graceful-degradation concern yet —
// every column exists from day one. Revisit if a later migration adds columns
// to an already-deployed table.

const SYNC_STATE_COLUMNS = [
  "last_sync_at",
  "last_full_sync_at",
  "last_sync_status",
  "last_sync_error",
  "last_customers_updated_at",
  "last_locations_updated_at",
  "last_jobs_updated_at",
  "last_contacts_synced_at",
  "last_technicians_synced_at",
  "last_appointments_synced_at",
  "last_normalized_at",
];

async function getSyncState(companyId) {
  const { rows } = await db.query(
    `SELECT ${SYNC_STATE_COLUMNS.join(", ")} FROM inspectpoint_sync_state WHERE company_id = $1`,
    [companyId]
  );
  return rows[0] || null;
}

async function updateSyncState(companyId, data) {
  const entries = Object.entries(data).filter(([k, v]) => SYNC_STATE_COLUMNS.includes(k) && v !== undefined);
  if (entries.length === 0) return;

  const cols = entries.map(([k]) => k);
  const vals = entries.map(([, v]) => v);
  const setClauses = cols.map((c, i) => `${c} = $${i + 2}`).join(", ");
  const insertCols = ["company_id", ...cols].join(", ");
  const insertVals = ["$1", ...cols.map((_, i) => `$${i + 2}`)].join(", ");

  await db.query(
    `INSERT INTO inspectpoint_sync_state (${insertCols})
     VALUES (${insertVals})
     ON CONFLICT (company_id) DO UPDATE SET ${setClauses}`,
    [companyId, ...vals]
  );
}

// ── Raw upserts ───────────────────────────────────────────────────────────────

/**
 * Upsert a batch of raw rows into any of the six inspectpoint_* tables.
 * `companyId` is one value applied to the whole batch (a sync run is always
 * scoped to one company) — matches upsertCustomersBatch(companyId, rows)'s
 * convention in db/servicetrade-sync.js — so row mapper functions don't need
 * to thread companyId through every row themselves.
 *
 * @param {string} table — e.g. "inspectpoint_jobs"
 * @param {string[]} extraColumns — the table's own typed columns beyond
 *   company_id/inspectpoint_id/payload/ip_updated_at (e.g. for
 *   inspectpoint_jobs: ["inspectpoint_location_id", "inspectpoint_customer_id",
 *   "inspectpoint_technician_id", "status_code", "scheduled_at", "due_date"]).
 * @param {string|number} companyId
 * @param {Array<object>} rows — each must have `inspectpointId`, `payload`,
 *   `ipUpdatedAt`, plus a snake_case key matching each extraColumn.
 * @returns {Promise<number>} rows processed
 */
async function upsertRawBatch(table, extraColumns, companyId, rows, { batchSize = BATCH_SIZE } = {}) {
  if (!rows.length) return 0;
  const columns = ["company_id", "inspectpoint_id", ...extraColumns, "payload", "ip_updated_at"];

  // Dedupe on the conflict key before building any statement. Postgres rejects
  // an INSERT ... ON CONFLICT whose VALUES list names the same conflict target
  // twice ("cannot affect row a second time"), which fails the WHOLE batch —
  // and every one of these endpoints is offset-paginated over live data, so a
  // row shifting between pages legitimately comes back twice (observed: a bulk
  // visit pull returning 2,599 rows for 2,596 distinct ids).
  //
  // Last occurrence wins: later pages are read later, so that copy is the
  // fresher one. Deduping here rather than at each call site keeps all six
  // entity types covered by one guard.
  const byId = new Map();
  for (const row of rows) byId.set(String(row.inspectpointId), row);
  if (byId.size !== rows.length) {
    logger.info("inspectpoint upsertRawBatch: dropped duplicate ids from a paginated fetch", {
      table, companyId, received: rows.length, unique: byId.size,
    });
  }
  const deduped = [...byId.values()];

  for (let i = 0; i < deduped.length; i += batchSize) {
    const chunk = deduped.slice(i, i + batchSize);
    const values = [];
    const params = [];
    let idx = 0;
    for (const row of chunk) {
      const placeholders = [];
      for (const col of columns) {
        idx++;
        placeholders.push(col === "payload" ? `$${idx}::jsonb` : `$${idx}`);
      }
      values.push(`(${placeholders.join(", ")}, NOW())`);
      params.push(companyId, row.inspectpointId);
      for (const col of extraColumns) params.push(row[col] ?? null);
      params.push(JSON.stringify(row.payload || {}));
      params.push(row.ipUpdatedAt ?? null);
    }
    const updateSet = [...extraColumns, "payload", "ip_updated_at"]
      .map((c) => `${c} = EXCLUDED.${c}`)
      .concat(["updated_at = NOW()"])
      .join(", ");
    await db.query(
      `INSERT INTO ${table} (${columns.join(", ")}, updated_at)
       VALUES ${values.join(", ")}
       ON CONFLICT (company_id, inspectpoint_id) DO UPDATE SET ${updateSet}`,
      params
    );
  }
  logger.info("inspectpoint upsertRawBatch: table upserted", { table, companyId, rows: deduped.length, batches: Math.ceil(deduped.length / batchSize) });
  return deduped.length;
}

// ── Raw list (debug/browse passthrough) ──────────────────────────────────────

/**
 * Generic paginated list over any of the six raw tables — they're uniform
 * enough (company_id, id, optional soft-FK filter column) that one function
 * covers all six, unlike ServiceTrade's per-table listCustomers/listJobs/etc.
 *
 * @param {string} table
 * @param {string|number} companyId
 * @param {{page?: number, perPage?: number, filterColumn?: string, filterValue?: any}} [opts]
 */
async function listRaw(table, companyId, { page = 1, perPage = 50, filterColumn = null, filterValue = null } = {}) {
  const offset = (page - 1) * perPage;
  const filterClause = filterColumn && filterValue != null ? ` AND ${filterColumn} = $2` : "";
  const params = filterColumn && filterValue != null ? [companyId, filterValue] : [companyId];

  const { rows } = await db.query(
    `SELECT * FROM ${table} WHERE company_id = $1${filterClause} ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, perPage, offset]
  );
  const { rows: countRows } = await db.query(`SELECT COUNT(*) AS total FROM ${table} WHERE company_id = $1${filterClause}`, params);
  return { rows, total: Number(countRows[0]?.total || 0) };
}

/**
 * Inspections we hold locally as open work with a scheduled date in
 * [from, to). Used ONLY to warn when a complete window pull didn't return one
 * of them — meaning it is no longer open upstream (cancelled/completed) or its
 * date moved, and our copy is now stale. Deliberately read-only: inferring a
 * terminal status from absence is unsafe, since a half-failed page would look
 * identical. See the "Deliberately NOT doing" note in the plan.
 */
async function listOpenInspectionIdsInWindow(companyId, from, to) {
  const { rows } = await db.query(
    `SELECT inspectpoint_id
       FROM inspectpoint_jobs
      WHERE company_id = $1
        AND status_code IN ('pending', 'scheduled')
        AND scheduled_at >= $2 AND scheduled_at < $3`,
    [companyId, from, to]
  );
  return rows.map((r) => String(r.inspectpoint_id));
}

module.exports = {
  getSyncState, updateSyncState, upsertRawBatch, listRaw,
  listOpenInspectionIdsInWindow,
};
