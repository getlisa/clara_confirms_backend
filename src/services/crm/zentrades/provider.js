/**
 * ZenTradesProvider — concrete CrmProvider implementation.
 *
 * Two-step pipeline like ServiceTrade/InspectPoint (RAW SYNC then
 * NORMALIZE), but DELIBERATELY zero mirror methods — base.js already
 * defaults every mirrorX method to `{skipped: "not_supported"}`, so
 * write-back deferral is expressed here by simply not overriding them, not
 * a gap to "fill in" later without a product decision first.
 *
 * Unlike InspectPointProvider's request(), which must thread an explicit
 * `credentials` object through every call (its client has no state of its
 * own), ZenTrades' client (services/zentrades.js) manages login/token
 * refresh internally keyed on companyId — so this provider's request() is a
 * thin pass-through, not a credentials-resolve-then-call.
 *
 * Normalize ordering, and why: customers first (no dependencies) -> contacts
 * (deduped by email — see normalize.js's dedupeContactsByEmail — needs to
 * happen before locations, since a location's primary_contact_id needs the
 * PLATFORM contact id, not a raw ref) -> technicians (no dependencies) ->
 * locations (needs customers + the deduped contacts) -> jobs (needs
 * customers + locations + technicians, and locations' own primary_contact_id
 * to mirror onto the job) -> appointments (needs jobs + technicians).
 * ZenTrades needs no junction tables at all (no offices/tags concept, and
 * assignment:appointment is 1:1 so there's exactly one technician per
 * appointment — nothing for appointment_technicians to represent), which is
 * genuinely simpler than both other providers here.
 */

const { CrmProvider } = require("../base");
const zt = require("../../zentrades");
const ztSync = require("../../zentrades-sync");
const ztCredsDb = require("../../../db/zentrades-credentials");
const db = require("../../../db");
const normalize = require("./normalize");
const logger = require("../../../utils/logger");

const SOURCE = "zentrades";
// fetchExternalRefMap defaults to source="servicetrade" — wrapping it here
// makes that default unreachable from this file rather than merely unused,
// per db/index.js's own warning: forgetting the source argument would
// silently cross-link ZenTrades rows to ServiceTrade's.
const refMap = (companyId, table) => db.fetchExternalRefMap(companyId, table, SOURCE);

class ZenTradesProvider extends CrmProvider {
  get slug() { return "zentrades"; }
  get supportedEntities() {
    return ["customers", "locations", "contacts", "technicians", "jobs", "appointments"];
  }

  async getCredentials(companyId) {
    return await ztCredsDb.getByCompanyId(companyId);
  }

  async request(companyId, method, path, opts = {}) {
    return await zt.request(companyId, method, path, opts);
  }

  /**
   * @param {string|number} companyId
   * @param {{full?: boolean, engine?: object|null, scheduleDateFrom?: number|null, scheduleDateTo?: number|null}} [opts]
   *   Same shape engines/crm-sync/index.js passes to every provider. `range`
   *   is accepted but unused (matches InspectPointProvider's signature —
   *   nothing here has a "week/month/3month" concept the way ServiceTrade's
   *   calendar-month default does).
   */
  async syncAll(companyId, { full = false, engine = null, scheduleDateFrom = null, scheduleDateTo = null } = {}) {
    try {
      const rawResult = await ztSync.runSync(companyId, { full, engine, scheduleDateFrom, scheduleDateTo });
      if (!rawResult.success) {
        return { ok: false, counts: rawResult.counts || {}, error: rawResult.error };
      }

      if (engine) await engine.transition("normalizing", {});
      logger.info("ZenTradesProvider: normalizing raw data into platform tables", { companyId, rawCounts: rawResult.counts });
      const normResult = await this.normalizeAll(companyId, engine);

      const counts = { ...rawResult.counts, normalized: normResult };
      const incomplete = rawResult.incomplete || [];
      if (incomplete.length) {
        logger.warn("ZenTradesProvider.syncAll: partial run, will retry these entities next tick", { companyId, incomplete, counts });
      } else {
        logger.info("ZenTradesProvider.syncAll done", { companyId, counts });
      }
      return { ok: true, counts, incomplete };
    } catch (err) {
      logger.error("ZenTradesProvider.syncAll failed", { companyId, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  async normalizeAll(companyId, engine = null) {
    const counts = { customers: 0, contacts: 0, technicians: 0, locations: 0, jobs: 0, appointments: 0 };
    const emit = (entity, count) => engine && engine.emit("entity_done", { entity, count });

    counts.customers = await this._normalizeCustomers(companyId);
    emit("customers", counts.customers);

    const rawContacts = await db.fetchAllByCompanyChunked(companyId, "zentrades_contacts");
    const { canonicalRows, alias } = normalize.dedupeContactsByEmail(rawContacts);

    // Each location's own on-site contact is deterministically `addr:<id>` —
    // no multi-candidate heuristic needed the way InspectPoint's
    // scheduling/owner role pick is, since ZenTrades never gives more than
    // one service-address contact per location.
    const rawLocations = await db.fetchAllByCompanyChunked(companyId, "zentrades_locations");
    const primaryRawRefByLocation = new Map();
    for (const loc of rawLocations) {
      const rawRef = `addr:${loc.zentrades_id}`;
      primaryRawRefByLocation.set(String(loc.zentrades_id), alias.get(rawRef) || rawRef);
    }
    const primaryCanonicalRefs = new Set(primaryRawRefByLocation.values());

    counts.contacts = await this._normalizeContacts(companyId, canonicalRows, primaryCanonicalRefs);
    emit("contacts", counts.contacts);

    counts.technicians = await this._normalizeTechnicians(companyId);
    emit("technicians", counts.technicians);

    counts.locations = await this._normalizeLocations(companyId, rawLocations, primaryRawRefByLocation);
    emit("locations", counts.locations);

    const rawTickets = await db.fetchAllByCompanyChunked(companyId, "zentrades_tickets");
    counts.jobs = await this._normalizeJobs(companyId, rawTickets);
    emit("jobs", counts.jobs);

    counts.appointments = await this._normalizeAppointments(companyId);
    emit("appointments", counts.appointments);

    return counts;
  }

  async _normalizeCustomers(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "zentrades_customers");
    const argsList = raw.map((row) => normalize.normalizeCustomer(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("customers", CUSTOMER_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeContacts(companyId, canonicalRows, primaryCanonicalRefs) {
    const argsList = canonicalRows
      .map((row) => normalize.normalizeContact(row, { companyId, isPrimary: primaryCanonicalRefs.has(String(row.zentrades_id)) }))
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("contacts", CONTACT_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeTechnicians(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "zentrades_technicians");
    const argsList = raw.map((row) => normalize.normalizeTechnician(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("technicians", TECHNICIAN_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeLocations(companyId, rawLocations, primaryRawRefByLocation) {
    const [customersMap, contactsMap] = await Promise.all([
      refMap(companyId, "customers"),
      refMap(companyId, "contacts"),
    ]);
    const argsList = rawLocations
      .map((row) => {
        const customerId = row.zentrades_customer_id != null ? customersMap.get(String(row.zentrades_customer_id)) ?? null : null;
        const primaryRef = primaryRawRefByLocation.get(String(row.zentrades_id));
        const primaryContactId = primaryRef != null ? contactsMap.get(primaryRef) ?? null : null;
        return normalize.normalizeLocation(row, { companyId, customerId, primaryContactId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("locations", LOCATION_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeJobs(companyId, rawTickets) {
    const [customersMap, locationsMap, techniciansMap] = await Promise.all([
      refMap(companyId, "customers"),
      refMap(companyId, "locations"),
      refMap(companyId, "technicians"),
    ]);
    // primary_contact_id on the job mirrors its location's own primary
    // contact — read straight off the already-normalized locations row
    // rather than re-deriving it, so the two never disagree (same pattern
    // as InspectPointProvider._normalizeJobs).
    const { rows: locationRows } = await db.query(
      `SELECT id, primary_contact_id FROM locations WHERE company_id = $1 AND source = $2`,
      [companyId, SOURCE]
    );
    const primaryContactByLocationId = new Map(locationRows.map((r) => [r.id, r.primary_contact_id]));

    const argsList = rawTickets
      .map((row) => {
        const p = row.payload || {};
        const customerId = row.zentrades_customer_id != null ? customersMap.get(String(row.zentrades_customer_id)) ?? null : null;
        const locationId = row.zentrades_location_id != null ? locationsMap.get(String(row.zentrades_location_id)) ?? null : null;
        const primaryContactId = locationId != null ? primaryContactByLocationId.get(locationId) ?? null : null;
        // Best-effort only — see normalizeJob's doc comment on why "the"
        // technician for a ticket is ambiguous. Earliest live assignment,
        // for list/filter convenience; appointments carry the real one.
        const liveAssignments = (Array.isArray(p.assignments) ? p.assignments : [])
          .filter((a) => a && a.isActive !== false && a.isDeleted !== true && a.startTime)
          .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
        const technicianId = liveAssignments[0]?.technicianId != null
          ? techniciansMap.get(String(liveAssignments[0].technicianId)) ?? null
          : null;
        return normalize.normalizeJob(row, { companyId, customerId, locationId, technicianId, primaryContactId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("jobs", JOB_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeAppointments(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "zentrades_appointments");
    const [jobsMap, techniciansMap] = await Promise.all([
      refMap(companyId, "jobs"),
      refMap(companyId, "technicians"),
    ]);
    const argsList = raw
      .map((row) => {
        const jobId = row.zentrades_ticket_id != null ? jobsMap.get(String(row.zentrades_ticket_id)) ?? null : null;
        const technicianId = row.zentrades_technician_id != null ? techniciansMap.get(String(row.zentrades_technician_id)) ?? null : null;
        return normalize.normalizeAppointment(row, { companyId, jobId, technicianId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("appointments", APPOINTMENT_FIELDS, argsList);
    return argsList.length;
  }
}

// ── Field descriptors for db.bulkUpsertByExternalRef ────────────────────────

const CUSTOMER_FIELDS = [
  { column: "full_name", key: "fullName" },
  { column: "email", key: "email" },
  { column: "phone", key: "phone" },
  { column: "address_line1", key: "addressLine1" },
  { column: "city", key: "city" },
  { column: "state", key: "state" },
  { column: "zipcode", key: "zipcode" },
  { column: "country", key: "country", transform: (v) => v || "US" },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const LOCATION_FIELDS = [
  { column: "customer_id", key: "customerId" },
  { column: "primary_contact_id", key: "primaryContactId" },
  { column: "name", key: "name" },
  { column: "lat", key: "lat" },
  { column: "lon", key: "lon" },
  { column: "phone", key: "phone" },
  { column: "email", key: "email" },
  { column: "general_manager_name", key: "generalManagerName" },
  { column: "address_line1", key: "addressLine1" },
  { column: "city", key: "city" },
  { column: "state", key: "state" },
  { column: "zipcode", key: "zipcode" },
  { column: "country", key: "country", transform: (v) => v || "US" },
  { column: "taxable", key: "taxable" },
  { column: "company", key: "company", jsonb: true },
  { column: "brand", key: "brand", jsonb: true },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const CONTACT_FIELDS = [
  { column: "first_name", key: "firstName" },
  { column: "last_name", key: "lastName" },
  { column: "phone", key: "phone" },
  { column: "mobile", key: "mobile" },
  { column: "alternate_phone", key: "alternatePhone" },
  { column: "email", key: "email" },
  { column: "type", key: "type" },
  { column: "types", key: "types", jsonb: true },
  { column: "contact_role", key: "contactRole", transform: (v) => v || "general" },
];

const TECHNICIAN_FIELDS = [
  { column: "first_name", key: "firstName" },
  { column: "last_name", key: "lastName" },
  { column: "email", key: "email" },
  { column: "phone", key: "phone" },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const JOB_FIELDS = [
  { column: "customer_id", key: "customerId" },
  { column: "location_id", key: "locationId" },
  { column: "technician_id", key: "technicianId" },
  { column: "primary_contact_id", key: "primaryContactId" },
  { column: "title", key: "title" },
  { column: "description", key: "description" },
  { column: "job_type", key: "jobType" },
  { column: "status", key: "status", transform: (v) => v || "open" },
  { column: "scheduled_date", key: "scheduledDate" },
  { column: "scheduled_window_start", key: "scheduledWindowStart" },
  { column: "scheduled_window_end", key: "scheduledWindowEnd" },
  { column: "job_number", key: "jobNumber" },
  { column: "external_ids", key: "externalIds", jsonb: true },
];

const APPOINTMENT_FIELDS = [
  { column: "job_id", key: "jobId" },
  { column: "technician_id", key: "technicianId" },
  { column: "scheduled_start", key: "scheduledStart" },
  { column: "scheduled_end", key: "scheduledEnd" },
  {
    column: "status",
    key: "status",
    transform: (v) => v || "scheduled",
    // ZenTrades has no 'confirmed' state of its own either (same situation
    // as InspectPoint) — a plain overwrite here would reset every
    // appointment our agent confirmed back to 'scheduled' on the very next
    // sync, silently undoing real confirmations.
    updateExpr: `status = CASE WHEN appointments.status IN ('confirmed','rescheduled','cancelled') THEN appointments.status ELSE EXCLUDED.status END`,
  },
  { column: "duration", key: "duration" },
];

module.exports = new ZenTradesProvider();
