/**
 * ServiceTradeProvider — concrete CrmProvider implementation.
 *
 * Two-step pipeline:
 *   1. RAW SYNC: fetch from ServiceTrade API → upsert into 4 raw tables
 *      (delegated to src/services/servicetrade-sync.js).
 *   2. NORMALIZE: read raw tables → upsert into platform tables
 *      (customers / jobs / appointments / technicians).
 *
 * The normalize step resolves cross-table references (raw customer → platform
 * customer id) so jobs and appointments link correctly on the platform side.
 */

const { CrmProvider } = require("../base");
const stClient        = require("../../servicetrade");
const stEngine        = require("../../servicetrade-sync");
const stSyncDb        = require("../../../db/servicetrade-sync");
const stCredsDb       = require("../../../db/servicetrade-credentials");
const techDb          = require("../../../db/technicians");
const db              = require("../../../db");
const normalize       = require("./normalize");
const logger          = require("../../../utils/logger");

class ServiceTradeProvider extends CrmProvider {
  get slug() { return "servicetrade"; }
  get supportedEntities() { return ["customers", "jobs", "appointments", "technicians"]; }

  // ── Auth + HTTP ────────────────────────────────────────────────────────────

  async authenticate(companyId, { username, password }) {
    return await stClient.login(companyId, username, password);
  }

  async getCredentials(companyId) {
    return await stCredsDb.getByCompanyId(companyId);
  }

  async request(companyId, method, path, opts = {}) {
    const creds = await this.getCredentials(companyId);
    return await stClient.request(companyId, method, path, opts, creds);
  }

  // ── Sync ───────────────────────────────────────────────────────────────────

  /**
   * Pull from ServiceTrade, populate raw tables, then normalize into platform.
   * Optional `engine` (workflow-engine instance) receives state transitions
   * and progress events. When omitted (cron path), sync runs silently.
   */
  async syncAll(companyId, { full = false, engine = null } = {}) {
    try {
      const rawResult = await stEngine.runSync(companyId, { full, engine });
      if (!rawResult.success) {
        return { ok: false, counts: rawResult.counts || {}, error: rawResult.error };
      }

      if (engine) await engine.transition("normalizing", {});
      const normResult = await this.normalizeAll(companyId, { engine });

      const counts = { ...rawResult.counts, normalized: normResult };
      logger.info("ServiceTradeProvider.syncAll done", { companyId, counts });
      return { ok: true, counts };
    } catch (err) {
      logger.error("ServiceTradeProvider.syncAll failed", { companyId, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  /**
   * Normalize every raw entity for a company into platform tables.
   * Order matters: customers first (jobs depend on them), then technicians,
   * then jobs, then appointments (depend on both).
   */
  async normalizeAll(companyId, { engine = null } = {}) {
    const counts = { customers: 0, technicians: 0, jobs: 0, appointments: 0 };

    counts.customers   = await this._normalizeCustomers(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "customers", count: counts.customers });

    counts.technicians = await this._normalizeTechnicians(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "technicians", count: counts.technicians });

    counts.jobs        = await this._normalizeJobs(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "jobs", count: counts.jobs });

    counts.appointments = await this._normalizeAppointments(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "appointments", count: counts.appointments });

    return counts;
  }

  async _normalizeCustomers(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_customers WHERE company_id = $1",
      [companyId]
    );
    let n = 0;
    for (const row of raw) {
      const args = normalize.normalizeCustomer(row, { companyId });
      if (!args) continue;
      await upsertCustomer(args);
      n++;
      await emitWarnings(engine, "customer", args);
    }
    logger.info("ServiceTradeProvider: normalized customers", { companyId, count: n });
    return n;
  }

  async _normalizeTechnicians(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_technicians WHERE company_id = $1",
      [companyId]
    );
    let n = 0;
    for (const row of raw) {
      const args = normalize.normalizeTechnician(row, { companyId });
      if (!args) continue;
      const r = await techDb.upsertByExternalRef(args);
      if (r) n++;
      await emitWarnings(engine, "technician", args);
    }
    logger.info("ServiceTradeProvider: normalized technicians", { companyId, count: n });
    return n;
  }

  async _normalizeJobs(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_jobs WHERE company_id = $1",
      [companyId]
    );
    let n = 0;
    for (const row of raw) {
      let customerId = null;
      if (row.servicetrade_customer_id) {
        const { rows: cust } = await db.query(
          `SELECT id FROM customers
           WHERE company_id = $1 AND external_ref = $2 AND source = 'servicetrade'
           LIMIT 1`,
          [companyId, String(row.servicetrade_customer_id)]
        );
        customerId = cust[0]?.id ?? null;
      }

      const args = normalize.normalizeJob(row, { companyId, customerId });
      if (!args) continue;
      await upsertJob(args);
      n++;
      await emitWarnings(engine, "job", args);
    }
    logger.info("ServiceTradeProvider: normalized jobs", { companyId, count: n });
    return n;
  }

  async _normalizeAppointments(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_appointments WHERE company_id = $1",
      [companyId]
    );
    let n = 0;
    for (const row of raw) {
      // Resolve platform jobId
      let jobId = null;
      if (row.servicetrade_job_id) {
        const { rows: jr } = await db.query(
          `SELECT id FROM jobs WHERE company_id = $1 AND external_ref = $2 AND source = 'servicetrade' LIMIT 1`,
          [companyId, String(row.servicetrade_job_id)]
        );
        jobId = jr[0]?.id ?? null;
      }
      // Resolve platform technicianId (optional)
      let technicianId = null;
      if (row.servicetrade_technician_id) {
        const { rows: tr } = await db.query(
          `SELECT id FROM technicians WHERE company_id = $1 AND external_ref = $2 AND source = 'servicetrade' LIMIT 1`,
          [companyId, String(row.servicetrade_technician_id)]
        );
        technicianId = tr[0]?.id ?? null;
      }

      const args = normalize.normalizeAppointment(row, { companyId, jobId, technicianId });
      if (!args) continue;
      await upsertAppointment(args);
      n++;
      await emitWarnings(engine, "appointment", args);
    }
    logger.info("ServiceTradeProvider: normalized appointments", { companyId, count: n });
    return n;
  }

  // ── Normalizers (delegate to pure mappers) ─────────────────────────────────

  normalizeCustomer(raw, ctx)    { return normalize.normalizeCustomer(raw, ctx); }
  normalizeJob(raw, ctx)         { return normalize.normalizeJob(raw, ctx); }
  normalizeAppointment(raw, ctx) { return normalize.normalizeAppointment(raw, ctx); }
  normalizeTechnician(raw, ctx)  { return normalize.normalizeTechnician(raw, ctx); }
}

// ── Inline upsert helpers (platform tables) ─────────────────────────────────
// These call directly into the platform tables. Technicians has a dedicated
// DB module; customers/jobs/appointments don't yet, so we inline simple
// upsert-by-external_ref logic here.

async function upsertCustomer(a) {
  // 1) Match by external_ref + source (preferred — stable CRM ID)
  const byRef = await db.query(
    `SELECT id FROM customers WHERE company_id = $1 AND external_ref = $2 AND source = $3 LIMIT 1`,
    [a.companyId, a.externalRef, a.source]
  );
  if (byRef.rows.length > 0) {
    const r = await db.query(
      `UPDATE customers SET
         full_name=$1, email=$2, phone=COALESCE($3, customers.phone),
         address_line1=$4, city=$5, state=$6, zipcode=$7, country=$8,
         is_active=$9, additional_information=$10, updated_at=NOW()
       WHERE id=$11 RETURNING *`,
      [a.fullName, a.email, a.phone, a.addressLine1, a.city, a.state, a.zipcode,
       a.country || "US", a.isActive !== false,
       JSON.stringify(a.additionalInformation || {}), byRef.rows[0].id]
    );
    return r.rows[0];
  }

  // 2) Adopt a manually-added row by phone (only if phone present)
  if (a.phone) {
    const byPhone = await db.query(
      `SELECT id FROM customers WHERE company_id = $1 AND phone = $2 LIMIT 1`,
      [a.companyId, a.phone]
    );
    if (byPhone.rows.length > 0) {
      const r = await db.query(
        `UPDATE customers SET
           full_name=$1, email=$2, address_line1=$3, city=$4, state=$5,
           zipcode=$6, country=$7, is_active=$8, external_ref=$9, source=$10,
           additional_information=$11, updated_at=NOW()
         WHERE id=$12 RETURNING *`,
        [a.fullName, a.email, a.addressLine1, a.city, a.state, a.zipcode,
         a.country || "US", a.isActive !== false, a.externalRef, a.source,
         JSON.stringify(a.additionalInformation || {}), byPhone.rows[0].id]
      );
      return r.rows[0];
    }
  }

  // 3) Fresh insert
  const r = await db.query(
    `INSERT INTO customers
       (company_id, full_name, email, phone, address_line1, city, state, zipcode, country,
        is_active, external_ref, source, additional_information)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [a.companyId, a.fullName, a.email, a.phone, a.addressLine1, a.city, a.state, a.zipcode,
     a.country || "US", a.isActive !== false, a.externalRef, a.source,
     JSON.stringify(a.additionalInformation || {})]
  );
  return r.rows[0];
}

async function upsertJob(a) {
  const { rows: existing } = await db.query(
    `SELECT id FROM jobs WHERE company_id=$1 AND external_ref=$2 AND source=$3 LIMIT 1`,
    [a.companyId, a.externalRef, a.source]
  );
  if (existing.length > 0) {
    const r = await db.query(
      `UPDATE jobs SET customer_id=$1, title=$2, description=$3, job_type=$4, status=$5,
         scheduled_date=$6, scheduled_window_start=$7, scheduled_window_end=$8,
         additional_information=$9, updated_at=NOW() WHERE id=$10 RETURNING *`,
      [a.customerId, a.title, a.description, a.jobType, a.status || "open",
       a.scheduledDate, a.scheduledWindowStart, a.scheduledWindowEnd,
       JSON.stringify(a.additionalInformation || {}), existing[0].id]
    );
    return r.rows[0];
  }
  const r = await db.query(
    `INSERT INTO jobs
       (company_id, customer_id, title, description, job_type, status,
        scheduled_date, scheduled_window_start, scheduled_window_end,
        external_ref, source, additional_information)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [a.companyId, a.customerId, a.title, a.description, a.jobType, a.status || "open",
     a.scheduledDate, a.scheduledWindowStart, a.scheduledWindowEnd,
     a.externalRef, a.source, JSON.stringify(a.additionalInformation || {})]
  );
  return r.rows[0];
}

async function upsertAppointment(a) {
  // Match by (company_id, external_ref, source). No UNIQUE constraint, so manual upsert.
  const { rows: existing } = await db.query(
    `SELECT id FROM appointments WHERE company_id=$1 AND external_ref=$2 AND source=$3 LIMIT 1`,
    [a.companyId, a.externalRef, a.source]
  );
  if (existing.length > 0) {
    const r = await db.query(
      `UPDATE appointments SET job_id=$1, technician_id=$2, status=$3,
         scheduled_start=$4, scheduled_end=$5, additional_information=$6, updated_at=NOW()
       WHERE id=$7 RETURNING *`,
      [a.jobId, a.technicianId, a.status || "scheduled",
       a.scheduledStart, a.scheduledEnd, JSON.stringify(a.additionalInformation || {}),
       existing[0].id]
    );
    return r.rows[0];
  }
  const r = await db.query(
    `INSERT INTO appointments (company_id, job_id, technician_id, status,
        scheduled_start, scheduled_end, external_ref, source, additional_information)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [a.companyId, a.jobId, a.technicianId, a.status || "scheduled",
     a.scheduledStart, a.scheduledEnd, a.externalRef, a.source,
     JSON.stringify(a.additionalInformation || {})]
  );
  return r.rows[0];
}

async function emitWarnings(engine, entity, args) {
  if (!engine) return;
  const warnings = args?.additionalInformation?.warnings;
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  for (const w of warnings) {
    await engine.emit("warning", {
      entity,
      external_ref: args.externalRef,
      subject_name: args.fullName || `${args.firstName || ""} ${args.lastName || ""}`.trim() || null,
      code: w.code,
      message: w.message,
    });
  }
}

module.exports = new ServiceTradeProvider();
