/**
 * Refresh ONE job from its CRM — the ↻ button on every job and the
 * pre-outreach check (docs/crm-sync-strategy.md §3.2/§4.3a,
 * docs/crm-sync-frontend.md §2).
 *
 * The provider re-reads the job's whole graph (job, appointments, technicians,
 * services, customer, location, contacts, deficiencies, service requests,
 * notes) and writes it through the normal raw → normalize path. This module
 * wraps that with a before/after snapshot of the same graph from the platform
 * tables, so the caller gets a field-level list of what actually changed —
 * which is what the UI shows ("Visit moved 9:00 → 13:00 · new contact Dana").
 *
 * Diffing the platform tables (not the CRM payloads) keeps it provider-
 * agnostic and means the list describes exactly what the user will now see.
 */

const db = require("../db");
const logger = require("../utils/logger");

// One press per job per 10 s (per instance). Protects the CRM API from a
// double-click or an impatient user; a press during an in-flight refresh of
// the same job joins it instead of starting a second one.
const COOLDOWN_MS = 10_000;
const NON_CRM_SOURCES = new Set(["csv", "manual"]);
const lastStarted = new Map();
const inFlight = new Map();

// Fields compared per entity. Bookkeeping (ids, timestamps, raw payloads,
// additional_information) is deliberately left out: only what a person reads.
const FIELDS = {
  job: ["status", "title", "description", "job_type", "scheduled_date", "job_number", "technician_id",
        "customer_id", "location_id", "primary_contact_id", "owner_id", "salesperson_id"],
  appointment: ["scheduled_start", "scheduled_end", "status", "technician_id", "duration"],
  customer: ["full_name", "email", "phone", "alternate_phone", "address_line1", "city", "state", "zipcode", "is_active"],
  location: ["name", "phone", "email", "address_line1", "city", "state", "zipcode", "primary_contact_id",
             "general_manager_name", "is_active"],
  contact: ["first_name", "last_name", "phone", "mobile", "alternate_phone", "email", "status", "types"],
  deficiency: ["name", "description", "status", "is_resolved", "resolved_at"],
  service_line: ["status", "description", "completion"],
  service_request: ["status", "description", "window_start", "window_end", "service_line_id"],
  technician: [],
  note: [],
};

const fullName = (r) => [r.first_name, r.last_name].filter(Boolean).join(" ").trim() || null;
const clip = (t, n = 80) => (t && t.length > n ? `${t.slice(0, n - 1)}…` : t || null);

/**
 * The job's graph as `{ entity: Map(key → { id, label, values }) }`.
 * `key` identifies the same record before and after; notes have no stable id
 * (they're delete-and-reinserted per sync), so they're keyed by content.
 */
async function snapshot(companyId, jobId) {
  const { rows: [job] } = await db.query(`SELECT * FROM jobs WHERE id = $1 AND company_id = $2`, [jobId, companyId]);
  if (!job) return null;

  const q = (sql, params) => db.query(sql, params).then((r) => r.rows);
  const [appointments, technicians, services, customers, locations, contacts, deficiencies, serviceRequests, jobNotes, apptNotes] = await Promise.all([
    q(`SELECT * FROM appointments WHERE job_id = $1 AND company_id = $2`, [jobId, companyId]),
    q(`SELECT at.appointment_id, t.id, t.first_name, t.last_name
         FROM appointment_technicians at JOIN technicians t ON t.id = at.technician_id
        WHERE at.appointment_id IN (SELECT id FROM appointments WHERE job_id = $1 AND company_id = $2)`, [jobId, companyId]),
    q(`SELECT s.*, sl.name AS service_line_name
         FROM appointment_services s LEFT JOIN service_lines sl ON sl.id = s.service_line_id
        WHERE s.company_id = $2 AND (s.job_id = $1 OR s.appointment_id IN (SELECT id FROM appointments WHERE job_id = $1 AND company_id = $2))`, [jobId, companyId]),
    job.customer_id ? q(`SELECT * FROM customers WHERE id = $1 AND company_id = $2`, [job.customer_id, companyId]) : [],
    job.location_id ? q(`SELECT * FROM locations WHERE id = $1 AND company_id = $2`, [job.location_id, companyId]) : [],
    // Same reach and inactive filter as getJobContacts (db/jobs.js) — the
    // contacts the job page shows.
    q(`SELECT DISTINCT c.*
         FROM contacts c
         LEFT JOIN contact_companies cc ON cc.contact_id = c.id
         LEFT JOIN contact_locations cl ON cl.contact_id = c.id
        WHERE c.company_id = $1 AND c.status IS DISTINCT FROM 'inactive'
          AND (c.id = $2 OR cc.customer_id = $3 OR cl.location_id = $4)`,
      [companyId, job.primary_contact_id ?? null, job.customer_id ?? null, job.location_id ?? null]),
    q(`SELECT * FROM deficiencies WHERE company_id = $1 AND (job_id = $2 OR ($3::int IS NOT NULL AND location_id = $3))`,
      [companyId, jobId, job.location_id ?? null]),
    q(`SELECT * FROM service_requests WHERE company_id = $1 AND job_id = $2`, [companyId, jobId]),
    q(`SELECT type, text FROM job_notes WHERE job_id = $1 AND company_id = $2`, [jobId, companyId]),
    q(`SELECT n.appointment_id, n.type, n.text FROM appointment_notes n
        WHERE n.company_id = $2 AND n.appointment_id IN (SELECT id FROM appointments WHERE job_id = $1 AND company_id = $2)`, [jobId, companyId]),
  ]);

  const graph = Object.fromEntries(Object.keys(FIELDS).map((e) => [e, new Map()]));
  const put = (entity, key, id, label, row, extra = {}) => {
    const values = {};
    for (const f of FIELDS[entity]) values[f] = row[f];
    graph[entity].set(String(key), { id, label, values, ...extra });
  };

  put("job", job.id, job.id, job.title || null, job);
  for (const a of appointments) put("appointment", a.id, a.id, null, a, { job_id: job.id });
  for (const t of technicians) put("technician", `${t.appointment_id}:${t.id}`, t.id, fullName(t), t, { appointment_id: t.appointment_id });
  for (const s of services) {
    put("service_line", `${s.appointment_id ?? "job"}:${s.service_line_id ?? s.external_ref ?? s.id}:${s.kind ?? ""}`,
      s.id, s.service_line_name || clip(s.description), s, { appointment_id: s.appointment_id ?? null });
  }
  for (const c of customers) put("customer", c.id, c.id, c.full_name || null, c);
  for (const l of locations) put("location", l.id, l.id, l.name || null, l);
  for (const c of contacts) put("contact", c.id, c.id, fullName(c) || c.email || null, c);
  for (const d of deficiencies) put("deficiency", d.id, d.id, d.name || clip(d.description), d);
  for (const r of serviceRequests) put("service_request", r.id, r.id, clip(r.description), r);
  // Keyed by text, not type: ServiceTrade files one comment under several
  // note categories (jobComments + locTechComments), which is one change to
  // the person reading the summary.
  for (const n of jobNotes) put("note", `job|${n.text}`, null, clip(n.text), n);
  for (const n of apptNotes) put("note", `${n.appointment_id}|${n.text}`, null, clip(n.text), n, { appointment_id: n.appointment_id });
  return graph;
}

const comparable = (v) => {
  if (v instanceof Date) return v.toISOString();
  if (v === undefined) return null;
  return v;
};
const same = (a, b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));

/** Field-level differences between two snapshots, in a stable order. */
function diffGraphs(before, after) {
  const changes = [];
  for (const entity of Object.keys(FIELDS)) {
    const b = before[entity], a = after[entity];
    const meta = (rec) => ({
      ...(rec.label ? { label: rec.label } : {}),
      ...(rec.appointment_id != null ? { appointment_id: rec.appointment_id } : {}),
    });
    for (const [key, rec] of a) {
      const prev = b.get(key);
      if (!prev) { changes.push({ entity, id: rec.id, action: "created", ...meta(rec) }); continue; }
      for (const field of FIELDS[entity]) {
        if (!same(prev.values[field], rec.values[field])) {
          changes.push({ entity, id: rec.id, action: "updated", field,
            from: comparable(prev.values[field]), to: comparable(rec.values[field]), ...meta(rec) });
        }
      }
    }
    for (const [key, rec] of b) {
      if (!a.has(key)) changes.push({ entity, id: rec.id, action: "removed", ...meta(rec) });
    }
  }
  return changes;
}

class RefreshError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/**
 * @returns {Promise<{changed: boolean, changes: object[], refreshed_at: string, partial: boolean}>}
 * @throws {RefreshError} code: not_found | not_syncable | not_supported | too_soon |
 *   not_in_crm | reconnect_required | crm_unavailable
 */
async function refreshJob(companyId, jobId, { trigger = "manual", skipCooldown = false } = {}) {
  const key = `${companyId}:${jobId}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const since = Date.now() - (lastStarted.get(key) || 0);
  if (!skipCooldown && since < COOLDOWN_MS) {
    throw new RefreshError("too_soon", "This job was just refreshed", { retry_after_s: Math.ceil((COOLDOWN_MS - since) / 1000) });
  }

  const run = (async () => {
    const { rows: [job] } = await db.query(
      `SELECT id, source, external_ref, customer_id, location_id, primary_contact_id FROM jobs WHERE id = $1 AND company_id = $2`,
      [jobId, companyId]
    );
    if (!job) throw new RefreshError("not_found", "Job not found");
    // CSV imports and hand-made jobs have nowhere to be refreshed from.
    const provider = job.source && !NON_CRM_SOURCES.has(job.source) ? safeProvider(job.source) : null;
    if (!provider) throw new RefreshError("not_syncable", "This job isn't linked to a CRM");
    if (typeof provider.refreshJob !== "function") throw new RefreshError("not_supported", `Refresh isn't available for ${job.source} yet`);

    lastStarted.set(key, Date.now());
    const started = Date.now();
    const before = await snapshot(companyId, jobId);
    const result = await provider.refreshJob(companyId, job);
    if (!result.ok) throw new RefreshError(result.code || "crm_unavailable", result.error || "Refresh failed");
    const after = await snapshot(companyId, jobId);
    const changes = after ? diffGraphs(before, after) : [];

    logger.info("Job refresh done", {
      companyId, jobId, source: job.source, trigger, ms: Date.now() - started, changes: changes.length,
      incomplete: result.incomplete,
    });
    return {
      changed: changes.length > 0,
      changes,
      refreshed_at: new Date().toISOString(),
      partial: (result.incomplete || []).length > 0,
    };
  })();

  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}

// The CRM registry is required lazily: providers pull in modules that lead
// back to the routes, and a top-level require closes that loop (same reason
// servicetrade-webhook-processor.js loads the provider lazily).
function safeProvider(slug) {
  try { return require("./crm").getProvider(slug); } catch { return null; }
}

module.exports = { refreshJob, RefreshError, snapshot, diffGraphs, COOLDOWN_MS, _reset: () => { lastStarted.clear(); inFlight.clear(); } };
