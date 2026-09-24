/**
 * CsvImportEngine — turns a stored upload into platform rows.
 *
 * State machine:
 *   started → parsing → mapping → writing_customers → writing_locations
 *           → writing_contacts → writing_jobs → writing_appointments
 *           → done | failed
 *
 * ── Why this one runs in the FOREGROUND ─────────────────────────────────────
 *
 * engines/crm-sync starts its work un-awaited and returns immediately, which
 * is fine for a cron-triggered sync that can simply run again in two hours. It
 * is NOT fine here. On Vercel the instance can freeze the moment the HTTP
 * response is sent, and nothing in the platform resumes an interrupted run —
 * `/admin/engines/gc`'s reapStaleRuns only flips a silent run to `failed`. A
 * fire-and-forget import would therefore look queued and then simply never
 * happen, with no error anyone could act on.
 *
 * So `start()` awaits the work inside the request's 300s budget and returns a
 * finished engine. Progress still flows through the same transition/emit
 * events, so an SSE client sees the run unfold exactly as it does for a sync.
 *
 * Restart-safety comes from the import being replayable rather than resumable:
 * every write is an upsert keyed on (company_id, external_ref, source), and
 * the file's text is kept on the csv_imports row, so re-running is always safe
 * and always converges. That is what POST /imports/csv/:id/reprocess does.
 */

const { Engine } = require("../core/engine");
const db = require("../../db");
const csvImportsDb = require("../../db/csv-imports");
const { getCompanyTimezone } = require("../../utils/timezone");
const { parseSpreadsheet } = require("../../services/csv-import/parser");
const { mapRows } = require("../../services/csv-import/mapper");
const entities = require("../../services/csv-import/entities");
const logger = require("../../utils/logger");

const SOURCE = entities.SOURCE;

/**
 * @param {{companyId: number, importId: string|number, startedBy?: number, dateOrder?: "DMY"|"MDY"}} opts
 * @returns {Promise<Engine>} an already-finished engine (see the header)
 */
async function start({ companyId, importId, startedBy = null, dateOrder = null, mapping = null }) {
  const engine = await Engine.create({ kind: "csv_import", companyId, startedBy });
  await run(engine, { companyId, importId, dateOrder, mapping });
  return engine;
}

async function run(engine, { companyId, importId, dateOrder, mapping }) {
  return engine.wrap(async () => {
    const record = await csvImportsDb.getById(importId, companyId, { includeContent: true });
    if (!record) throw new Error("Import not found.");
    if (!record.rawContent) {
      // The 30-day retention sweep has cleared the file. The summary row still
      // exists (that's the archive), but there is nothing left to re-run from.
      throw new Error("The uploaded file is no longer stored (files are kept for 30 days). Upload it again to re-import.");
    }

    await csvImportsDb.markRunning(importId, companyId, engine.id);

    let result;
    try {
      result = await processImport(engine, { companyId, record, dateOrder, mapping });
    } catch (err) {
      // The engine's own wrap() will mark the RUN failed; this makes sure the
      // import record carries the same verdict, since that is what the UI
      // reads after the run has been garbage-collected.
      await csvImportsDb.markFailed(importId, companyId, err.message).catch(() => {});
      throw err;
    }

    await csvImportsDb.markCompleted(importId, companyId, result);
    return result;
  });
}

async function processImport(engine, { companyId, record, dateOrder, mapping }) {
  const timezone = await getCompanyTimezone(companyId);

  await engine.transition("parsing", { filename: record.filename });
  const parsed = await parseSpreadsheet(Buffer.from(record.rawContent, "utf8"), record.filename);
  for (const w of parsed.warnings) await engine.emit("warning", w);

  // The column mapping the upload was validated against is stored ON the
  // import, so a reprocess applies the same one without the caller having to
  // resend it. An explicit argument still wins — that's how a user corrects a
  // mapping and re-runs. Omitting this entirely (as an earlier version did)
  // meant the route accepted a mapping, stored it, and then the engine
  // re-derived the columns from scratch without it, so every mapped import
  // failed inside the run with the very error the mapping was meant to fix.
  const effectiveMapping = mapping && Object.keys(mapping).length ? mapping : (record.columnMapping || {});

  await engine.transition("mapping", { rows: parsed.rows.length });
  const mapped = mapRows(parsed, { timezone, dateOrder, mapping: effectiveMapping });
  await engine.emit("mapped", {
    total: parsed.rows.length,
    usable: mapped.rows.length,
    errors: mapped.errors.length,
    warnings: mapped.warnings.length,
    dateOrder: mapped.dateOrder,
  });
  // Rows that imported but lost something on the way — a customer who ended up
  // email-only because their phone had no area code, say. Worth telling the
  // office about: it explains why those customers never get a call.
  for (const w of mapped.warnings.slice(0, 50)) await engine.emit("warning", w);

  // ── The raw layer ─────────────────────────────────────────────────────────
  //
  // Stage EVERY row as it was read — including the ones that failed to map —
  // before anything touches the platform tables. This is the same raw-mirror
  // layer inspectpoint_*/servicetrade_* provide for an API sync, and it earns
  // its keep the same way: the error report can show a bad row's original
  // cells beside the reason, a mapper fix can be replayed against historical
  // imports, and a re-normalize needs neither the file nor a re-parse.
  //
  // Mapping runs first only so each staged row can carry its own outcome
  // (`mapped` or `error`) in a single write rather than a second update pass.
  // The raw `payload` is stored either way, which is what "raw" has to mean.
  await engine.transition("staging", { rows: parsed.rows.length });
  const errorByRow = new Map(mapped.errors.map((e) => [e.row, e]));
  const mappedByRow = new Map(mapped.rows.map((r) => [r.rowNumber, r]));
  const staged = parsed.rows.map((payload, i) => {
    const rowNumber = i + 2; // header is row 1; matches mapper.js's numbering
    const m = mappedByRow.get(rowNumber) || null;
    return {
      rowNumber,
      reference: m?.reference ?? null,
      jobReference: m?.jobReference ?? null,
      payload,
      mapped: m,
      error: errorByRow.get(rowNumber)?.message ?? null,
    };
  });
  await csvImportsDb.replaceRows(record.id, companyId, staged);
  await engine.emit("entity_done", { entity: "csv_import_rows", count: staged.length });

  const built = entities.buildEntities(mapped.rows, { companyId, timezone });

  // Ordering matches the CRM normalizers (crm/inspectpoint/provider.js's
  // normalizeAll): each stage's foreign keys are resolved from the external-ref
  // map of the stage before it, so customers must exist before locations can
  // point at them, and so on.
  await engine.transition("writing_customers");
  await upsert("customers", entities.CUSTOMER_FIELDS, built.customers, engine);

  const customerMap = await refMap(companyId, "customers");

  await engine.transition("writing_locations");
  const locations = built.locations.map((l) => ({ ...l, customerId: customerMap.get(l.customerRef) ?? null }));
  await upsert("locations", entities.LOCATION_FIELDS, locations, engine);

  await engine.transition("writing_contacts");
  await upsert("contacts", entities.CONTACT_FIELDS, built.contacts, engine);

  const [locationMap, contactMap] = await Promise.all([
    refMap(companyId, "locations"),
    refMap(companyId, "contacts"),
  ]);

  await engine.transition("writing_jobs");
  const jobs = built.jobs.map((j) => ({
    ...j,
    customerId: customerMap.get(j.customerRef) ?? null,
    locationId: j.locationRef ? locationMap.get(j.locationRef) ?? null : null,
    primaryContactId: j.contactRef ? contactMap.get(j.contactRef) ?? null : null,
  }));
  await upsert("jobs", entities.JOB_FIELDS, jobs, engine);

  const jobMap = await refMap(companyId, "jobs");

  await engine.transition("writing_appointments");
  // Technicians are matched by name against whatever the company already has;
  // a CSV rarely carries a stable technician id, and inventing technician rows
  // from a name column would fill the roster with typos. An unmatched name
  // leaves technician_id null — the visit still gets confirmed, it just isn't
  // attributed.
  const technicianMap = await technicianIdsByName(companyId);
  const appointments = built.appointments.map((a) => ({
    ...a,
    jobId: jobMap.get(a.jobRef) ?? null,
    technicianId: a.technicianName ? technicianMap.get(a.technicianName.trim().toLowerCase()) ?? null : null,
  }));
  // An appointment with no job would violate nothing in the schema (job_id is
  // nullable) but would be invisible to the confirmation sweep, which joins
  // through jobs — so drop it loudly rather than writing a row that can never
  // be acted on.
  const orphans = appointments.filter((a) => a.jobId == null);
  if (orphans.length) {
    logger.error("csv-import: appointments had no resolvable job — skipped", {
      companyId, count: orphans.length, refs: orphans.slice(0, 5).map((a) => a.externalRef),
    });
    await engine.emit("warning", { code: "orphan_appointments", message: `${orphans.length} visit(s) could not be linked to a job and were skipped.` });
  }
  const writable = appointments.filter((a) => a.jobId != null);
  await upsert("appointments", entities.APPOINTMENT_FIELDS, writable, engine);

  return {
    dateOrder: mapped.dateOrder,
    totalRows: parsed.rows.length,
    importedRows: writable.length,
    errorRows: mapped.errors.length,
    errors: mapped.errors,
    counts: {
      customers: built.customers.length,
      locations: locations.length,
      contacts: built.contacts.length,
      jobs: jobs.length,
      appointments: writable.length,
    },
  };
}

async function upsert(table, fields, rows, engine) {
  if (!rows.length) {
    await engine.emit("entity_done", { entity: table, count: 0 });
    return;
  }
  await db.bulkUpsertByExternalRef(table, fields, rows);
  await engine.emit("entity_done", { entity: table, count: rows.length });
}

/** external_ref -> platform id, scoped to this source. */
function refMap(companyId, table) {
  return db.fetchExternalRefMap(companyId, table, SOURCE);
}

/**
 * Lowercased "first last" -> technician id, across ALL sources: a CSV company
 * may still have had technicians created by hand, and matching only
 * source='csv' ones would miss them.
 */
async function technicianIdsByName(companyId) {
  const { rows } = await db.query(
    `SELECT id, first_name, last_name FROM technicians WHERE company_id = $1 AND is_active = true`,
    [companyId]
  );
  const map = new Map();
  for (const r of rows) {
    const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim().toLowerCase();
    if (name && !map.has(name)) map.set(name, r.id);
  }
  return map;
}

module.exports = { start };
