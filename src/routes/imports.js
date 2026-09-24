/**
 * CSV / XLSX import — upload, preview, process, reprocess.
 *
 * ── Why the file arrives as a RAW body, not multipart ───────────────────────
 *
 * The obvious choice is multer + multipart/form-data, and the plan originally
 * called for it. Raw body won on three counts: it adds no dependency (multer
 * is not installed, and `express.raw` is already how routes/retell.js takes
 * its webhook payload), it carries binary .xlsx without base64's 33% inflation
 * — which matters against Vercel's ~4.5 MB request-body ceiling — and the
 * frontend side is no harder (`fetch(url, {method:"POST", body: file})`).
 *
 * The filename rides in a query param because it decides which parser runs.
 *
 *   POST /imports/csv?filename=jobs.csv[&dryRun=true][&dateOrder=MDY]
 *   GET  /imports/csv                 — recent uploads for this company
 *   GET  /imports/csv/:id             — one upload, with its error list
 *   POST /imports/csv/:id/reprocess   — re-run from the stored file
 *
 * Every response is company-scoped via `authenticate`; nothing here trusts an
 * id or a companyId from the body.
 */

const express = require("express");
const { authenticate } = require("../auth/auth.middleware");
const csvImportsDb = require("../db/csv-imports");
const csvImportEngine = require("../engines/csv-import");
const engineToken = require("../engines/core/token");
const { getCompanyTimezone } = require("../utils/timezone");
const { parseSpreadsheet } = require("../services/csv-import/parser");
const { mapRows, describeMapping, TARGET_FIELDS } = require("../services/csv-import/mapper");
const logger = require("../utils/logger");

const router = express.Router();

/**
 * Vercel caps a serverless request body at roughly 4.5 MB, so accepting more
 * than this would fail at the platform edge with an opaque error rather than
 * the readable one below. A confirmation list for a week is kilobytes; this
 * ceiling is generous.
 */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

router.use(authenticate);

/** `express.raw` for the upload route only — every other route here is JSON. */
const rawBody = express.raw({
  type: () => true, // the browser may send text/csv, an xlsx mime, or nothing
  limit: MAX_UPLOAD_BYTES,
});

/**
 * `?mapping=` is a JSON object because the request BODY is already the file.
 * Returns `{}` when absent, or `undefined` when it's present but unusable —
 * which the caller turns into a 400 rather than silently ignoring, since
 * quietly dropping a mapping the user just drew would import the wrong columns.
 */
function parseMappingParam(raw) {
  if (raw == null || raw === "") return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** The five-field body every engine-backed route in this codebase returns. */
function streamEnvelope(engine, companyId) {
  const streamToken = engineToken.sign({ runId: engine.id, companyId });
  return {
    runId: String(engine.id),
    kind: engine.kind,
    streamToken,
    streamUrl: `/engines/${engine.id}/stream?token=${encodeURIComponent(streamToken)}`,
    snapshotUrl: `/engines/${engine.id}`,
  };
}

/**
 * Upload a file.
 *
 * Headers are validated synchronously here rather than inside the background
 * run, so a mis-shaped file fails immediately with a message naming the
 * missing column — the single most common support case for any importer.
 *
 * `dryRun=true` stores the file and returns the same validation summary
 * WITHOUT writing any platform rows, so the office can check a file before
 * committing to it.
 */
router.post("/csv", rawBody, async (req, res) => {
  try {
    const companyId = req.user.companyId;
    // getUserId's field is `userId`; routes/engines.js and inspectpoint.js both
    // read `req.user.id` here and silently record NULL. Don't inherit that.
    const uploadedBy = req.user.userId ?? null;

    const filename = String(req.query.filename || "").trim();
    if (!filename) return res.status(400).json({ error: "A `filename` query parameter is required so we know how to read the file." });

    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || buffer.length === 0) return res.status(400).json({ error: "The request body was empty — send the file's bytes as the body." });

    const dryRun = req.query.dryRun === "true";
    const dateOrder = req.query.dateOrder === "MDY" || req.query.dateOrder === "DMY" ? req.query.dateOrder : null;

    // An explicit column mapping from the mapping UI, as {field: "Their Header"}.
    // Sent as a JSON string because this request's body is the file itself.
    let mapping = parseMappingParam(req.query.mapping);
    if (mapping === undefined) return res.status(400).json({ error: "`mapping` must be a JSON object of {field: columnName}." });
    // Fall back to whatever this company mapped last time, so a recurring
    // export only ever needs mapping once.
    if (!Object.keys(mapping).length) mapping = (await csvImportsDb.getSavedMapping(companyId))?.mapping || {};

    // Validate BEFORE storing: a file we can't even read is not worth a row.
    const timezone = await getCompanyTimezone(companyId);
    let preview;
    try {
      const parsed = await parseSpreadsheet(buffer, filename);
      const mapped = mapRows(parsed, { timezone, dateOrder, mapping });
      preview = {
        totalRows: parsed.rows.length,
        usableRows: mapped.rows.length,
        errorRows: mapped.errors.length,
        errors: mapped.errors.slice(0, 50),
        dateOrder: mapped.dateOrder,
        headers: parsed.headers,
        // What each field ended up reading, whether from the explicit mapping,
        // a remembered one, or alias matching — so the UI can show "Phone ←
        // Contact Mobile" rather than leaving the user to guess.
        mapping: mapped.mapping,
        unknownColumns: mapped.unknownColumns,
        warnings: parsed.warnings,
      };
    } catch (err) {
      // A whole-file rejection — missing required column, unreadable date
      // order, wrong file type. The message is written for the uploader.
      //
      // When it's specifically "we couldn't work out which column is which",
      // the response carries everything the mapping UI needs to open straight
      // into a column-mapping step: the file's headers, the fields they can be
      // mapped onto with a ranked column list each, and our best guesses. That
      // turns a dead end into one screen the user can actually finish.
      if (err.code === "UNMAPPED_COLUMNS") {
        return res.status(422).json({ error: err.message, code: err.code, mappingRequired: true, ...err.details });
      }
      return res.status(422).json({ error: err.message });
    }

    const record = await csvImportsDb.create({
      companyId, uploadedBy,
      // Denormalised so the archive still names the uploader after that user
      // is deactivated or removed — the FK is ON DELETE SET NULL.
      uploadedByEmail: req.user.email ?? null,
      filename, fileSize: buffer.length,
      rawContent: buffer.toString("utf8"),
      columnMapping: mapping,
    });

    // Remember an EXPLICIT mapping so the next upload of the same report needs
    // no mapping step. Only when the caller supplied one — persisting a mapping
    // our own suggestions produced would make the next upload silently inherit
    // a guess as though a human had approved it.
    if (Object.keys(parseMappingParam(req.query.mapping) || {}).length) {
      await csvImportsDb.saveMapping(companyId, mapping, { sourceHeaders: preview.headers, updatedBy: uploadedBy })
        .catch((err) => logger.warn("csv-import: could not save the column mapping", { error: err.message, companyId }));
    }

    if (dryRun) {
      logger.info("csv-import: dry run", { companyId, importId: record.id, ...preview, errors: undefined });
      return res.status(200).json({ importId: record.id, dryRun: true, preview });
    }

    const engine = await csvImportEngine.start({ companyId, importId: record.id, startedBy: uploadedBy, dateOrder });
    const finished = await csvImportsDb.getById(record.id, companyId);
    logger.info("csv-import: upload processed", { companyId, importId: record.id, status: finished?.status });

    return res.status(202).json({ importId: record.id, preview, import: finished, ...streamEnvelope(engine, companyId) });
  } catch (err) {
    // express.raw rejects an oversized body with a 413-flavoured error.
    if (err?.type === "entity.too.large" || err?.status === 413) {
      return res.status(413).json({ error: `That file is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit. Split it, or remove columns you don't need.` });
    }
    logger.error("csv-import: upload failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * The company's remembered column mapping, plus the full field catalogue.
 *
 * Lets the mapping screen render before a file is chosen, and lets Settings
 * show "your columns are mapped" without an upload.
 */
router.get("/csv/mapping", async (req, res) => {
  try {
    const saved = await csvImportsDb.getSavedMapping(req.user.companyId);
    return res.json({ mapping: saved?.mapping || {}, sourceHeaders: saved?.sourceHeaders || [], updatedAt: saved?.updatedAt || null, targetFields: TARGET_FIELDS });
  } catch (err) {
    logger.error("csv-import: mapping fetch failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/** Save a mapping without uploading — e.g. editing it from Settings. */
router.put("/csv/mapping", express.json(), async (req, res) => {
  try {
    const mapping = req.body?.mapping;
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
      return res.status(400).json({ error: "`mapping` must be an object of {field: columnName}." });
    }
    const saved = await csvImportsDb.saveMapping(req.user.companyId, mapping, {
      sourceHeaders: Array.isArray(req.body.sourceHeaders) ? req.body.sourceHeaders : [],
      updatedBy: req.user.userId ?? null,
    });
    return res.json(saved);
  } catch (err) {
    logger.error("csv-import: mapping save failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.get("/csv", async (req, res) => {
  try {
    const imports = await csvImportsDb.listByCompany(req.user.companyId, { limit: req.query.limit });
    return res.json({ imports });
  } catch (err) {
    logger.error("csv-import: list failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.get("/csv/:id", async (req, res) => {
  try {
    const record = await csvImportsDb.getById(req.params.id, req.user.companyId);
    if (!record) return res.status(404).json({ error: "Import not found" });
    return res.json({ import: record });
  } catch (err) {
    logger.error("csv-import: fetch failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * The raw rows staged for an import — the spreadsheet as we actually read it.
 *
 * `?onlyErrors=true` is what the error report should use: it returns each bad
 * row's ORIGINAL cells alongside the reason, which is the difference between
 * "row 14: could not read the phone number" and a user having to reopen their
 * spreadsheet to find out what row 14 even said.
 *
 * Returns an empty list once the 30-day retention sweep has run; `import
 * .contentAvailable` tells you which case you're in.
 */
router.get("/csv/:id/rows", async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const record = await csvImportsDb.getById(req.params.id, companyId);
    if (!record) return res.status(404).json({ error: "Import not found" });

    const rows = await csvImportsDb.listRows(req.params.id, companyId, {
      onlyErrors: req.query.onlyErrors === "true",
      limit: req.query.limit,
      offset: req.query.offset,
    });
    return res.json({ rows, contentAvailable: record.contentAvailable, errorRows: record.errorRows });
  } catch (err) {
    logger.error("csv-import: rows fetch failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Re-run an import from the file we already stored.
 *
 * This is the restart story: nothing resumes a run that died mid-flight
 * (engines GC only marks it failed), but every write is an upsert keyed on
 * (company_id, external_ref, source), so replaying is always safe and always
 * converges. Also the way to apply a corrected `dateOrder` to a file that was
 * read the wrong way round.
 *
 * companyId is re-derived from the stored row and checked against the caller's
 * — never taken from the request body.
 */
router.post("/csv/:id/reprocess", async (req, res) => {
  try {
    const companyId = req.user.companyId;
    const record = await csvImportsDb.getById(req.params.id, companyId);
    if (!record) return res.status(404).json({ error: "Import not found" });
    if (record.status === "running") return res.status(409).json({ error: "That import is already running." });
    // Caught here rather than inside the run so the caller gets a 410 it can
    // act on ("upload the file again") instead of a failed engine run.
    if (!record.contentAvailable) {
      return res.status(410).json({ error: "The uploaded file is no longer stored (files are kept for 30 days). Upload it again to re-import." });
    }

    const dateOrder = req.body?.dateOrder === "MDY" || req.body?.dateOrder === "DMY" ? req.body.dateOrder : null;
    // A mapping here CORRECTS the one the import was stored with — the whole
    // point of re-running after fixing a mis-mapped column. Omitted, the engine
    // falls back to the mapping already on the record.
    const mapping = req.body?.mapping && typeof req.body.mapping === "object" && !Array.isArray(req.body.mapping)
      ? req.body.mapping
      : null;
    if (mapping) {
      await csvImportsDb.saveMapping(companyId, mapping, { updatedBy: req.user.userId ?? null })
        .catch((err) => logger.warn("csv-import: could not save the corrected mapping", { error: err.message, companyId }));
    }

    const engine = await csvImportEngine.start({
      companyId, importId: record.id, startedBy: req.user.userId ?? null, dateOrder, mapping,
    });
    const finished = await csvImportsDb.getById(record.id, companyId);
    return res.status(202).json({ importId: record.id, import: finished, ...streamEnvelope(engine, companyId) });
  } catch (err) {
    logger.error("csv-import: reprocess failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
