/**
 * csv_imports — one row per uploaded file (migrations/109_csv_import.sql).
 *
 * The row holds the file's own text, which is what makes a reprocess possible
 * without asking the user to upload again. On Vercel nothing resumes an
 * interrupted run (`/admin/engines/gc`'s reapStaleRuns only marks a silent run
 * failed), so "re-run it from what we stored" is the whole restart story.
 */

const db = require("./index");
const logger = require("../utils/logger");

/**
 * Per-row errors are capped before storage. An unbounded array is how a
 * 50,000-bad-row file turns one JSONB column into hundreds of megabytes — the
 * exact failure the reference implementation left open. The full count is
 * always kept in `error_rows`, so nothing is misreported; only the detail list
 * is truncated.
 */
const MAX_STORED_ERRORS = 500;

/**
 * How long an uploaded file and its raw rows are kept.
 *
 * The csv_imports SUMMARY row is kept forever — that's the archive the office
 * browses. What expires is the bulky part: the file text and the per-row raw
 * mirror. 30 days matches the engine_runs GC window, so an import and its
 * progress trail disappear on roughly the same schedule.
 */
const CONTENT_RETENTION_DAYS = 30;

/** Rows per INSERT when staging the raw layer — same reasoning as the CRM raw upserts. */
const ROW_BATCH_SIZE = 500;

function rowToObject(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    companyId: Number(row.company_id),
    uploadedBy: row.uploaded_by != null ? Number(row.uploaded_by) : null,
    uploadedByEmail: row.uploaded_by_email,
    filename: row.filename,
    fileSize: row.file_size,
    // The file itself is purged after CONTENT_RETENTION_DAYS; the UI needs to
    // know that a re-run is no longer possible rather than offering one.
    contentPurgedAt: row.content_purged_at,
    contentAvailable: row.content_purged_at == null,
    status: row.status,
    engineRunId: row.engine_run_id != null ? String(row.engine_run_id) : null,
    dateOrder: row.date_order,
    columnMapping: row.column_mapping || {},
    totalRows: row.total_rows,
    importedRows: row.imported_rows,
    errorRows: row.error_rows,
    errors: row.errors || [],
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** Columns for every read that doesn't need the (potentially multi-MB) file text. */
const SUMMARY_COLUMNS = `id, company_id, uploaded_by, uploaded_by_email, filename, file_size,
  content_purged_at, status, engine_run_id, date_order, column_mapping,
  total_rows, imported_rows, error_rows,
  errors, error, created_at, started_at, finished_at`;

async function create({ companyId, uploadedBy = null, uploadedByEmail = null, filename, fileSize, rawContent, columnMapping = {} }) {
  const { rows } = await db.query(
    `INSERT INTO csv_imports (company_id, uploaded_by, uploaded_by_email, filename, file_size, raw_content, column_mapping)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING ${SUMMARY_COLUMNS}`,
    [companyId, uploadedBy, uploadedByEmail, filename, fileSize, rawContent, JSON.stringify(columnMapping || {})]
  );
  return rowToObject(rows[0]);
}

/**
 * Read one import, scoped by company.
 *
 * companyId is a REQUIRED argument rather than an optional filter so a caller
 * cannot accidentally read across tenants by omitting it — routes/engines.js
 * spreads `...req.body` after companyId and is exactly the shape of bug worth
 * not repeating here.
 */
async function getById(id, companyId, { includeContent = false } = {}) {
  const { rows } = await db.query(
    `SELECT ${SUMMARY_COLUMNS}${includeContent ? ", raw_content" : ""}
       FROM csv_imports WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!rows[0]) return null;
  const out = rowToObject(rows[0]);
  if (includeContent) out.rawContent = rows[0].raw_content;
  return out;
}

async function listByCompany(companyId, { limit = 20 } = {}) {
  const { rows } = await db.query(
    `SELECT ${SUMMARY_COLUMNS} FROM csv_imports
      WHERE company_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [companyId, Math.min(Number(limit) || 20, 100)]
  );
  return rows.map(rowToObject);
}

/** Claim an import for processing. Returns null if it isn't in a startable state. */
async function markRunning(id, companyId, engineRunId) {
  const { rows } = await db.query(
    `UPDATE csv_imports
        SET status = 'running', engine_run_id = $3, started_at = NOW(),
            finished_at = NULL, error = NULL, updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND status IN ('pending', 'completed', 'failed')
      RETURNING ${SUMMARY_COLUMNS}`,
    [id, companyId, engineRunId]
  );
  return rowToObject(rows[0]);
}

async function markCompleted(id, companyId, { dateOrder, totalRows, importedRows, errorRows, errors }) {
  const stored = (errors || []).slice(0, MAX_STORED_ERRORS);
  if ((errors || []).length > MAX_STORED_ERRORS) {
    logger.warn("csv-import: truncated the stored error list", {
      importId: String(id), total: errors.length, stored: MAX_STORED_ERRORS,
    });
  }
  const { rows } = await db.query(
    `UPDATE csv_imports
        SET status = 'completed', date_order = $3, total_rows = $4, imported_rows = $5,
            error_rows = $6, errors = $7::jsonb, finished_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING ${SUMMARY_COLUMNS}`,
    [id, companyId, dateOrder ?? null, totalRows, importedRows, errorRows, JSON.stringify(stored)]
  );
  return rowToObject(rows[0]);
}

async function markFailed(id, companyId, errorMessage) {
  const { rows } = await db.query(
    `UPDATE csv_imports
        SET status = 'failed', error = $3, finished_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING ${SUMMARY_COLUMNS}`,
    [id, companyId, String(errorMessage).slice(0, 2000)]
  );
  return rowToObject(rows[0]);
}

// ── The remembered column mapping ───────────────────────────────────────────

/** The company's saved mapping, or null if they've never confirmed one. */
async function getSavedMapping(companyId) {
  const { rows } = await db.query(
    `SELECT mapping, source_headers, updated_at FROM csv_column_mappings WHERE company_id = $1`,
    [companyId]
  );
  if (!rows[0]) return null;
  return { mapping: rows[0].mapping || {}, sourceHeaders: rows[0].source_headers || [], updatedAt: rows[0].updated_at };
}

/**
 * Remember the mapping a user just confirmed, so their next upload of the same
 * report needs no mapping step at all.
 *
 * Called only with a mapping the user explicitly supplied — never with one our
 * own suggestions produced, because saving a guess would make the next upload
 * silently inherit it as though it had been approved.
 */
async function saveMapping(companyId, mapping, { sourceHeaders = [], updatedBy = null } = {}) {
  const { rows } = await db.query(
    `INSERT INTO csv_column_mappings (company_id, mapping, source_headers, updated_by)
     VALUES ($1, $2::jsonb, $3::jsonb, $4)
     ON CONFLICT (company_id) DO UPDATE
       SET mapping = EXCLUDED.mapping,
           source_headers = EXCLUDED.source_headers,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()
     RETURNING mapping, source_headers, updated_at`,
    [companyId, JSON.stringify(mapping || {}), JSON.stringify(sourceHeaders || []), updatedBy]
  );
  return { mapping: rows[0].mapping, sourceHeaders: rows[0].source_headers, updatedAt: rows[0].updated_at };
}

// ── The raw layer: csv_import_rows ──────────────────────────────────────────

/**
 * Stage every parsed row of an import, replacing anything already staged for it.
 *
 * Replace-not-append because a reprocess re-reads the same file: appending
 * would double the raw mirror on every re-run, and the (csv_import_id,
 * row_number) unique constraint would reject it anyway. Deleting first is
 * simpler than an upsert here since the whole set is always rewritten together.
 *
 * Runs in one transaction so a failure part-way cannot leave an import with
 * half its rows staged — a half-mirror is worse than none, because it looks
 * complete.
 *
 * @param {Array<{rowNumber, reference, jobReference, payload, mapped, error}>} rows
 */
async function replaceRows(csvImportId, companyId, rows) {
  return db.transaction(async (client) => {
    await client.query(`DELETE FROM csv_import_rows WHERE csv_import_id = $1 AND company_id = $2`, [csvImportId, companyId]);
    if (!rows.length) return 0;

    for (let i = 0; i < rows.length; i += ROW_BATCH_SIZE) {
      const chunk = rows.slice(i, i + ROW_BATCH_SIZE);
      const values = [];
      const params = [];
      let p = 0;
      for (const r of chunk) {
        values.push(`($${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}::jsonb, $${++p}::jsonb, $${++p})`);
        params.push(
          companyId, csvImportId, r.rowNumber,
          r.reference ?? null, r.jobReference ?? null,
          JSON.stringify(r.payload || {}),
          r.mapped ? JSON.stringify(r.mapped) : null,
          r.error ?? null
        );
      }
      await client.query(
        `INSERT INTO csv_import_rows
           (company_id, csv_import_id, row_number, reference, job_reference, payload, mapped, error)
         VALUES ${values.join(", ")}`,
        params
      );
    }
    logger.info("csv-import: staged raw rows", { importId: String(csvImportId), rows: rows.length });
    return rows.length;
  });
}

/**
 * Read staged rows for an import. `onlyErrors` backs the error report, which is
 * the common case and the reason for the partial index on that predicate.
 */
async function listRows(csvImportId, companyId, { onlyErrors = false, limit = 500, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT row_number, reference, job_reference, payload, mapped, error
       FROM csv_import_rows
      WHERE csv_import_id = $1 AND company_id = $2
        ${onlyErrors ? "AND error IS NOT NULL" : ""}
      ORDER BY row_number
      LIMIT $3 OFFSET $4`,
    [csvImportId, companyId, Math.min(Number(limit) || 500, 2000), Number(offset) || 0]
  );
  return rows.map((r) => ({
    rowNumber: r.row_number,
    reference: r.reference,
    jobReference: r.job_reference,
    payload: r.payload,
    mapped: r.mapped,
    error: r.error,
  }));
}

/**
 * Retention sweep — drop the file text and the raw rows for imports older than
 * `days`, keeping the summary row so the archive stays complete.
 *
 * Deliberately NOT a delete of the import itself: "what did we import on the
 * 3rd, and who uploaded it" is exactly the question an archive exists to
 * answer, and it costs a few hundred bytes to keep forever. What's expensive
 * is the file and its per-row mirror, and those are what expire.
 *
 * Idempotent — the `content_purged_at IS NULL` predicate means a second run in
 * the same window does nothing.
 */
async function purgeExpiredContent({ days = CONTENT_RETENTION_DAYS } = {}) {
  const cutoffDays = Math.max(Number(days) || CONTENT_RETENTION_DAYS, 1);

  const { rows: expired } = await db.query(
    `UPDATE csv_imports
        SET raw_content = NULL, content_purged_at = NOW(), updated_at = NOW()
      WHERE content_purged_at IS NULL
        AND created_at < NOW() - ($1 || ' days')::interval
      RETURNING id`,
    [String(cutoffDays)]
  );
  if (!expired.length) return { purgedFiles: 0, deletedRows: 0 };

  const ids = expired.map((r) => r.id);
  const { rowCount } = await db.query(`DELETE FROM csv_import_rows WHERE csv_import_id = ANY($1::bigint[])`, [ids]);

  logger.info("csv-import: retention sweep", { days: cutoffDays, purgedFiles: ids.length, deletedRows: rowCount });
  return { purgedFiles: ids.length, deletedRows: rowCount };
}

module.exports = {
  create, getById, listByCompany, markRunning, markCompleted, markFailed,
  replaceRows, listRows, purgeExpiredContent,
  getSavedMapping, saveMapping,
  MAX_STORED_ERRORS, CONTENT_RETENTION_DAYS,
};
