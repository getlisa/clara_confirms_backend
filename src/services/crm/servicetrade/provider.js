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
const callSettingsDb  = require("../../../db/call-settings");
const { inferJobConfirmations } = require("../../job-confirmation-inference");
const logger          = require("../../../utils/logger");

class ServiceTradeProvider extends CrmProvider {
  get slug() { return "servicetrade"; }
  get supportedEntities() {
    return [
      "customers", "jobs", "appointments", "technicians", "contacts", "offices", "tags", "locations",
      "crm_users", "projects", "scheduling_comments", "job_notes", "appointment_notes",
      "service_lines", "deficiencies", "change_orders", "contracts", "service_recurrences",
      "service_requests", "service_opportunities",
    ];
  }

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
  async syncAll(companyId, { full = false, engine = null, range = "month" } = {}) {
    try {
      const rawResult = await stEngine.runSync(companyId, { full, engine, range });
      if (!rawResult.success) {
        return { ok: false, counts: rawResult.counts || {}, error: rawResult.error };
      }

      // Keep companies.default_timezone in sync with the CRM's account timezone
      // on every sync (self-healing; a single cheap unpaginated request — unlike
      // the paginated entity fetches above). Best-effort, never blocks normalize.
      // Required lazily (not at module top) — servicetrade-account.js pulls in
      // servicetrade-api.js -> crm/index.js, which requires this very file,
      // creating a load-time circular require if imported at the top.
      require("../../servicetrade-account").syncAccountTimezone(companyId).catch((err) => {
        logger.warn("ServiceTradeProvider.syncAll: account timezone sync failed", { companyId, error: err.message });
      });

      if (engine) await engine.transition("normalizing", {});
      logger.info("ServiceTradeProvider: normalizing raw data into platform tables", { companyId, rawCounts: rawResult.counts });
      const normResult = await this.normalizeAll(companyId, { engine });

      const counts = { ...rawResult.counts, normalized: normResult };
      const incomplete = rawResult.incomplete || [];
      if (incomplete.length) {
        logger.warn("ServiceTradeProvider.syncAll: partial run, will retry these entities next cron tick", { companyId, incomplete, counts });
      } else {
        logger.info("ServiceTradeProvider.syncAll done", { companyId, counts });
      }
      return { ok: true, counts, incomplete };
    } catch (err) {
      logger.error("ServiceTradeProvider.syncAll failed", { companyId, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  /**
   * Normalize every raw entity for a company into platform tables.
   * Order matters: customers first (jobs + locations depend on them), then
   * contacts/offices/tags (locations depend on contacts; the location_offices/
   * location_tags junctions depend on offices/tags), then locations, then
   * technicians, then jobs, then appointments (depend on both).
   */
  async normalizeAll(companyId, { engine = null } = {}) {
    const counts = {
      customers: 0, technicians: 0, crmUsers: 0, projects: 0, jobs: 0, appointments: 0,
      contacts: 0, offices: 0, tags: 0, locations: 0,
      serviceLines: 0, deficiencies: 0, changeOrders: 0, contracts: 0, serviceRecurrences: 0,
      serviceRequests: 0, serviceOpportunities: 0, appointmentServices: 0,
      schedulingComments: 0, jobNotes: 0, appointmentNotes: 0,
      confirmationAssessments: 0,
    };

    counts.customers   = await this._normalizeCustomers(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "customers", count: counts.customers });

    // Raw jobs are read here rather than just before _normalizeJobs because
    // contacts (normalized first) need to know which of them ServiceTrade
    // names as a job's primaryContact. Read ONCE and reused throughout —
    // jobs payloads are tens of KB each, and re-reading per method was what
    // tripped the DB statement timeout on larger accounts. Chunked rather
    // than one unbounded SELECT — see fetchAllByCompanyChunked.
    const rawJobs = await db.fetchAllByCompanyChunked(companyId, "servicetrade_jobs");

    // Computed ONCE and threaded through every method that resolves a contact
    // id, so they all agree on which record survived the merge (see
    // dedupeContactsByEmail). Recomputing per method would read the raw
    // contacts table 4x for an identical result.
    const contactDedupe = dedupeContactsByEmail(
      await db.fetchAllByCompanyChunked(companyId, "servicetrade_contacts")
    );

    // ServiceTrade ids of contacts it names as a primaryContact — on a job
    // and/or on a location. Everything else is classified "general".
    const primaryContactRefs = await this._collectPrimaryContactRefs(companyId, rawJobs, contactDedupe);

    counts.contacts    = await this._normalizeContacts(companyId, engine, contactDedupe, primaryContactRefs);
    if (engine) await engine.emit("entity_done", { entity: "contacts", count: counts.contacts });

    counts.offices     = await this._normalizeOffices(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "offices", count: counts.offices });

    counts.tags        = await this._normalizeTags(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "tags", count: counts.tags });

    counts.locations   = await this._normalizeLocations(companyId, engine, contactDedupe);
    if (engine) await engine.emit("entity_done", { entity: "locations", count: counts.locations });

    await this._normalizeLocationOffices(companyId);
    await this._normalizeLocationTags(companyId);
    await this._normalizeContactJunctions(companyId, contactDedupe);

    counts.technicians = await this._normalizeTechnicians(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "technicians", count: counts.technicians });

    counts.crmUsers    = await this._normalizeCrmUsers(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "crm_users", count: counts.crmUsers });

    counts.projects    = await this._normalizeProjects(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "projects", count: counts.projects });

    // First jobs pass: resolves customer/owner/salesperson/office/project.
    // contract_id/current_appointment_id resolve to null here (contracts and
    // appointments don't exist yet) — a second pass at the end backfills them.
    counts.jobs        = await this._normalizeJobs(companyId, engine, rawJobs, contactDedupe);
    if (engine) await engine.emit("entity_done", { entity: "jobs", count: counts.jobs });

    await this._normalizeJobOffices(companyId, rawJobs);
    await this._normalizeJobTags(companyId, rawJobs);
    counts.schedulingComments = await this._normalizeSchedulingComments(companyId, rawJobs);
    counts.jobNotes           = await this._normalizeJobNotes(companyId, rawJobs);

    const rawAppointments = await db.fetchAllByCompanyChunked(companyId, "servicetrade_appointments");

    counts.appointments = await this._normalizeAppointments(companyId, engine, rawAppointments);
    if (engine) await engine.emit("entity_done", { entity: "appointments", count: counts.appointments });

    await this._normalizeAppointmentTechnicians(companyId, rawAppointments);
    await this._normalizeAppointmentOffices(companyId, rawAppointments);
    counts.appointmentNotes = await this._normalizeAppointmentNotes(companyId, rawAppointments);

    // Infer confirmation status from ServiceTrade's own human-entered
    // comments/notes (just normalized above) — off by default per company,
    // since a wrong inference could silently suppress a real confirmation
    // dispatch (see job-confirmation-inference.js).
    const callSettings = await callSettingsDb.getByCompanyId(companyId).catch(() => null);
    if (callSettings?.job_confirmation_inference_enabled) {
      counts.confirmationAssessments = await inferJobConfirmations(companyId).catch((err) => {
        logger.error("ServiceTradeProvider.normalizeAll: job confirmation inference failed", { companyId, error: err.message });
        return 0;
      });
    }

    // Service-request-derived entities — independent of each other, so order
    // among them doesn't matter, but all must run before service_requests
    // (which resolves FKs into every one of them, plus jobs/locations above).
    counts.serviceLines        = await this._normalizeServiceLines(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "service_lines", count: counts.serviceLines });

    counts.deficiencies        = await this._normalizeDeficiencies(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "deficiencies", count: counts.deficiencies });

    counts.changeOrders        = await this._normalizeChangeOrders(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "change_orders", count: counts.changeOrders });

    counts.contracts           = await this._normalizeContracts(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "contracts", count: counts.contracts });

    counts.serviceRecurrences  = await this._normalizeServiceRecurrences(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "service_recurrences", count: counts.serviceRecurrences });

    // Second jobs pass: contract_id (from _normalizeContracts, just above)
    // and current_appointment_id (from _normalizeAppointments, above) can
    // only resolve now that both tables are populated. Raw job rows
    // themselves haven't changed since the first pass — reuse rawJobs
    // instead of re-scanning servicetrade_jobs a second time.
    await this._normalizeJobs(companyId, engine, rawJobs, contactDedupe);

    counts.serviceRequests = await this._normalizeServiceRequests(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "service_requests", count: counts.serviceRequests });

    counts.serviceOpportunities = await this._normalizeServiceOpportunities(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "service_opportunities", count: counts.serviceOpportunities });

    await this._normalizeServiceOpportunityPreferredTechs(companyId);
    await this._normalizeServiceRequestPreferredTechs(companyId);

    counts.appointmentServices = await this._normalizeAppointmentServices(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "appointment_services", count: counts.appointmentServices });

    return counts;
  }

  async _normalizeCustomers(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_customers");
    const argsList = raw.map((row) => normalize.normalizeCustomer(row, { companyId })).filter(Boolean);
    const n = await bulkUpsertCustomers(companyId, argsList);
    logger.info("ServiceTradeProvider: normalized customers", { companyId, count: n });
    return n;
  }

  /**
   * Only ONE platform contact per real person — see dedupeContactsByEmail.
   * `dropped` ids had a platform row before the dedupe existed, so they're
   * deleted here; their junction rows cascade away and are rebuilt against the
   * canonical contact by _normalizeContactJunctions, and jobs.primary_contact_id
   * (ON DELETE SET NULL) is repointed by the _normalizeJobs pass that follows.
   */
  /**
   * ServiceTrade ids of every contact it names as a `primaryContact`, from
   * both the job payloads and the raw locations table. Returned as canonical
   * ids (resolved through the dedupe alias) so the flag lands on whichever
   * record survived the email merge.
   */
  async _collectPrimaryContactRefs(companyId, rawJobs, dedupe = null) {
    const canonical = (id) => dedupe?.alias?.get(String(id)) ?? String(id);
    const refs = new Set();
    for (const row of rawJobs) {
      const payload = row.payload || {};
      if (payload.primaryContact?.id != null) refs.add(canonical(payload.primaryContact.id));
      if (payload.location?.primaryContact?.id != null) refs.add(canonical(payload.location.primaryContact.id));
    }
    // Locations carry their own primary contact as a flat column.
    const { rows } = await db.query(
      `SELECT DISTINCT servicetrade_primary_contact_id AS id
         FROM servicetrade_locations
        WHERE company_id = $1 AND servicetrade_primary_contact_id IS NOT NULL`,
      [companyId]
    );
    for (const r of rows) refs.add(canonical(r.id));
    logger.info("ServiceTradeProvider: collected primary contact refs", { companyId, count: refs.size });
    return refs;
  }

  async _normalizeContacts(companyId, engine = null, dedupe = null, primaryRefs = null) {
    const { canonicalRows, dropped } =
      dedupe || dedupeContactsByEmail(await db.fetchAllByCompanyChunked(companyId, "servicetrade_contacts"));
    const argsList = canonicalRows
      .map((row) => normalize.normalizeContact(row, {
        companyId,
        isPrimary: primaryRefs ? primaryRefs.has(String(row.servicetrade_id)) : false,
      }))
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("contacts", CONTACT_FIELDS, argsList);
    if (dropped.length) {
      const { rowCount } = await db.query(
        `DELETE FROM contacts
          WHERE company_id = $1 AND source = 'servicetrade' AND external_ref = ANY($2::text[])`,
        [companyId, dropped]
      );
      logger.info("ServiceTradeProvider: removed duplicate contacts (same email)", { companyId, superseded: dropped.length, deleted: rowCount });
    }
    logger.info("ServiceTradeProvider: normalized contacts", { companyId, count: argsList.length, mergedAway: dropped.length });
    return argsList.length;
  }

  async _normalizeOffices(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_offices");
    const argsList = raw.map((row) => normalize.normalizeOffice(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("offices", OFFICE_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized offices", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeTags(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_tags");
    const argsList = raw.map((row) => normalize.normalizeTag(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("tags", TAG_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized tags", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeLocations(companyId, engine = null, dedupe = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_locations");
    // Bulk-fetch both FK maps ONCE instead of one lookup query per row.
    const [customersMap, contactsMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "customers"),
      db.fetchExternalRefMap(companyId, "contacts"),
    ]);
    // A location's primaryContact may be one of the duplicates that got merged
    // away, so resolve it through the alias to the surviving contact.
    const alias = dedupe?.alias ?? null;
    const canonicalContactRef = (stId) => alias?.get(String(stId)) ?? String(stId);
    const argsList = raw
      .map((row) => {
        const customerId       = row.servicetrade_customer_id       != null ? (customersMap.get(String(row.servicetrade_customer_id))       ?? null) : null;
        const primaryContactId = row.servicetrade_primary_contact_id != null ? (contactsMap.get(canonicalContactRef(row.servicetrade_primary_contact_id)) ?? null) : null;
        return normalize.normalizeLocation(row, { companyId, customerId, primaryContactId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("locations", LOCATION_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized locations", { companyId, count: argsList.length });
    return argsList.length;
  }

  /**
   * Junction: location ↔ offices. Reads `offices[]` already embedded in
   * servicetrade_locations.payload — no extra API call.
   */
  async _normalizeLocationOffices(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_locations", { columns: "id, servicetrade_id, payload" });
    const [locationsMap, officesMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "locations"),
      db.fetchExternalRefMap(companyId, "offices"),
    ]);
    const pairs = [];
    for (const row of raw) {
      const locationId = locationsMap.get(String(row.servicetrade_id));
      if (!locationId) continue;
      const offices = Array.isArray(row.payload?.offices) ? row.payload.offices : [];
      for (const o of offices) {
        if (o?.id == null) continue;
        const officeId = officesMap.get(String(o.id));
        if (officeId) pairs.push([locationId, officeId]);
      }
    }
    await bulkInsertJunction("location_offices", "location_id", "office_id", pairs);
  }

  /**
   * Junction: location ↔ tags. Reads `tags[]` already embedded in
   * servicetrade_locations.payload — no extra API call.
   */
  async _normalizeLocationTags(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_locations", { columns: "id, servicetrade_id, payload" });
    const [locationsMap, tagsMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "locations"),
      db.fetchExternalRefMap(companyId, "tags"),
    ]);
    const pairs = [];
    for (const row of raw) {
      const locationId = locationsMap.get(String(row.servicetrade_id));
      if (!locationId) continue;
      const tags = Array.isArray(row.payload?.tags) ? row.payload.tags : [];
      for (const t of tags) {
        if (t?.id == null) continue;
        const tagId = tagsMap.get(String(t.id));
        if (tagId) pairs.push([locationId, tagId]);
      }
    }
    await bulkInsertJunction("location_tags", "location_id", "tag_id", pairs);
  }

  /**
   * Junction: contact ↔ locations/companies (many-to-many). Reads the
   * `locations[]`/`companies[]` arrays already embedded in
   * servicetrade_contacts.payload — no extra API call. These are only
   * populated once a contact's raw payload actually carries them (the full
   * /contact response does; location.primaryContact's smaller embed
   * doesn't) — until then this is a no-op, which is expected.
   */
  async _normalizeContactJunctions(companyId, dedupe = null) {
    const rawContacts = await db.fetchAllByCompanyChunked(companyId, "servicetrade_contacts", { columns: "id, servicetrade_id, payload, email" });
    const alias = (dedupe || dedupeContactsByEmail(rawContacts)).alias;
    const [contactsMap, locationsMap, customersMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "contacts"),
      db.fetchExternalRefMap(companyId, "locations"),
      db.fetchExternalRefMap(companyId, "customers"),
    ]);
    const locationPairs = [];
    const companyPairs = [];
    // Every duplicate's links are walked, but resolved onto the CANONICAL
    // contact — so the surviving record ends up linked to every customer and
    // location any of its duplicates was seen at.
    for (const row of rawContacts) {
      const canonicalRef = alias.get(String(row.servicetrade_id)) ?? String(row.servicetrade_id);
      const contactId = contactsMap.get(canonicalRef);
      if (!contactId) continue;

      // The plural array only wins when it actually has entries — ServiceTrade's
      // real /contact?companyId= responses are inconsistent about this: some
      // contacts come back with `companies: []` (empty) even though the
      // singular `company` field IS populated (verified live — Louis Woodland,
      // Guillermo McLeod, and the location's own primary contact Tito Oporta
      // all did this for the same real customer). Array.isArray([]) is true,
      // so the old `Array.isArray(...) ? ... : fallback` form never reached
      // the singular fallback for these — silently dropping the link.
      const locations = Array.isArray(row.payload?.locations) && row.payload.locations.length
                       ? row.payload.locations
                       : row.payload?.location ? [row.payload.location] : [];
      for (const l of locations) {
        if (l?.id == null) continue;
        const locationId = locationsMap.get(String(l.id));
        if (locationId) locationPairs.push([contactId, locationId]);
      }

      const companiesArr = Array.isArray(row.payload?.companies) && row.payload.companies.length
                          ? row.payload.companies
                          : row.payload?.company ? [row.payload.company] : [];
      for (const c of companiesArr) {
        if (c?.id == null) continue;
        const customerId = customersMap.get(String(c.id));
        if (customerId) companyPairs.push([contactId, customerId]);
      }
    }
    await bulkInsertJunction("contact_locations", "contact_id", "location_id", locationPairs);
    await bulkInsertJunction("contact_companies", "contact_id", "customer_id", companyPairs);
  }

  async _normalizeTechnicians(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_technicians");
    const argsList = raw.map((row) => normalize.normalizeTechnician(row, { companyId })).filter(Boolean);
    const n = await techDb.bulkUpsertByExternalRef(companyId, argsList);
    logger.info("ServiceTradeProvider: normalized technicians", { companyId, count: n });
    return n;
  }

  async _normalizeCrmUsers(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_users");
    const argsList = raw.map((row) => normalize.normalizeCrmUser(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("crm_users", CRM_USER_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized crm users", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeProjects(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_projects");
    const argsList = raw.map((row) => normalize.normalizeProject(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("projects", PROJECT_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized projects", { companyId, count: argsList.length });
    return argsList.length;
  }

  /**
   * Resolves customer/owner/salesperson/assigned-office/project/contract/
   * current-appointment ids from the job's raw `payload` (owner/sales/office/
   * project/contract/currentAppointment are singular embeds, not junctions).
   * Called TWICE by normalizeAll — contract_id/current_appointment_id only
   * resolve on the second call, once contracts/appointments exist.
   */
  async _normalizeJobs(companyId, engine = null, rawJobs = null, dedupe = null) {
    const raw = rawJobs || (await db.fetchAllByCompanyChunked(companyId, "servicetrade_jobs"));
    const [customersMap, crmUsersMap, officesMap, projectsMap, contractsMap, appointmentsMap, locationsMap, contactsMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "customers"),
      db.fetchExternalRefMap(companyId, "crm_users"),
      db.fetchExternalRefMap(companyId, "offices"),
      db.fetchExternalRefMap(companyId, "projects"),
      db.fetchExternalRefMap(companyId, "contracts"),
      db.fetchExternalRefMap(companyId, "appointments"),
      db.fetchExternalRefMap(companyId, "locations"),
      db.fetchExternalRefMap(companyId, "contacts"),
    ]);
    const argsList = raw
      .map((row) => {
        const payload = row.payload || {};
        const customerId           = row.servicetrade_customer_id != null ? (customersMap.get(String(row.servicetrade_customer_id))    ?? null) : null;
        const ownerId              = payload.owner?.id             != null ? (crmUsersMap.get(String(payload.owner.id))                 ?? null) : null;
        const salespersonId        = payload.sales?.id             != null ? (crmUsersMap.get(String(payload.sales.id))                 ?? null) : null;
        const assignedOfficeId     = payload.office?.id            != null ? (officesMap.get(String(payload.office.id))                 ?? null) : null;
        const projectId            = payload.project?.id           != null ? (projectsMap.get(String(payload.project.id))               ?? null) : null;
        const contractId           = payload.contract?.id          != null ? (contractsMap.get(String(payload.contract.id))             ?? null) : null;
        const currentAppointmentId = payload.currentAppointment?.id != null ? (appointmentsMap.get(String(payload.currentAppointment.id)) ?? null) : null;
        const locationId           = payload.location?.id          != null ? (locationsMap.get(String(payload.location.id))              ?? null) : null;
        // The job's primaryContact may be a duplicate that got merged away —
        // resolve through the alias so it lands on the surviving contact.
        const primaryContactRef    = payload.primaryContact?.id != null
          ? (dedupe?.alias?.get(String(payload.primaryContact.id)) ?? String(payload.primaryContact.id))
          : null;
        const primaryContactId     = primaryContactRef != null ? (contactsMap.get(primaryContactRef) ?? null) : null;
        return normalize.normalizeJob(row, {
          companyId, customerId, ownerId, salespersonId, assignedOfficeId, projectId, contractId, currentAppointmentId,
          locationId, primaryContactId,
        });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("jobs", JOB_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized jobs", { companyId, count: argsList.length });
    return argsList.length;
  }

  /** Junction: job ↔ offices. Reads `offices[]` embedded in servicetrade_jobs.payload. */
  async _normalizeJobOffices(companyId, rawJobs = null) {
    const raw = rawJobs || (await db.fetchAllByCompanyChunked(companyId, "servicetrade_jobs", { columns: "id, servicetrade_id, payload" }));
    const [jobsMap, officesMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "jobs"),
      db.fetchExternalRefMap(companyId, "offices"),
    ]);
    const pairs = [];
    for (const row of raw) {
      const jobId = jobsMap.get(String(row.servicetrade_id));
      if (!jobId) continue;
      const offices = Array.isArray(row.payload?.offices) ? row.payload.offices : [];
      for (const o of offices) {
        if (o?.id == null) continue;
        const officeId = officesMap.get(String(o.id));
        if (officeId) pairs.push([jobId, officeId]);
      }
    }
    await bulkInsertJunction("job_offices", "job_id", "office_id", pairs);
  }

  /** Junction: job ↔ tags. Reads `tags[]` embedded in servicetrade_jobs.payload. */
  async _normalizeJobTags(companyId, rawJobs = null) {
    const raw = rawJobs || (await db.fetchAllByCompanyChunked(companyId, "servicetrade_jobs", { columns: "id, servicetrade_id, payload" }));
    const [jobsMap, tagsMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "jobs"),
      db.fetchExternalRefMap(companyId, "tags"),
    ]);
    const pairs = [];
    for (const row of raw) {
      const jobId = jobsMap.get(String(row.servicetrade_id));
      if (!jobId) continue;
      const tags = Array.isArray(row.payload?.tags) ? row.payload.tags : [];
      for (const t of tags) {
        if (t?.id == null) continue;
        const tagId = tagsMap.get(String(t.id));
        if (tagId) pairs.push([jobId, tagId]);
      }
    }
    await bulkInsertJunction("job_tags", "job_id", "tag_id", pairs);
  }

  /**
   * job.schedulingComments[] ({id, uri, job_id, content}) → platform
   * `scheduling_comments`. Real ServiceTrade ids, so upserted by external_ref
   * like everything else — read directly off the parent job's raw payload.
   */
  async _normalizeSchedulingComments(companyId, rawJobs = null) {
    const raw = rawJobs || (await db.fetchAllByCompanyChunked(companyId, "servicetrade_jobs", { columns: "id, servicetrade_id, payload" }));
    const jobsMap = await db.fetchExternalRefMap(companyId, "jobs");
    // Keyed by comment id, not pushed to an array: the same comment can
    // legitimately appear more than once across a company's jobs — a
    // duplicate external_ref within one batch INSERT makes Postgres error
    // with "ON CONFLICT DO UPDATE command cannot affect row a second time",
    // so de-dupe before upserting (same fix as the appointment/service-request
    // de-dupe in servicetrade-sync.js).
    const argsById = new Map();
    for (const row of raw) {
      const jobId = jobsMap.get(String(row.servicetrade_id));
      if (!jobId) continue;
      const comments = Array.isArray(row.payload?.schedulingComments) ? row.payload.schedulingComments : [];
      for (const c of comments) {
        if (c?.id == null) continue;
        const mapped = normalize.normalizeSchedulingComment(c, { companyId, jobId });
        if (mapped) argsById.set(Number(c.id), mapped);
      }
    }
    const argsList = Array.from(argsById.values());
    await db.bulkUpsertByExternalRef("scheduling_comments", SCHEDULING_COMMENT_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized scheduling comments", { companyId, count: argsList.length });
    return argsList.length;
  }

  /**
   * job.notes[] ({type, text}) → platform `job_notes`. No id/stable identity
   * in the payload, so this re-syncs by delete-and-reinsert per job rather
   * than upserting by external_ref (avoids duplicating rows on re-run).
   */
  async _normalizeJobNotes(companyId, rawJobs = null) {
    const raw = rawJobs || (await db.fetchAllByCompanyChunked(companyId, "servicetrade_jobs", { columns: "id, servicetrade_id, payload" }));
    const jobsMap = await db.fetchExternalRefMap(companyId, "jobs");
    const jobIds = [];
    const rows = [];
    for (const row of raw) {
      const jobId = jobsMap.get(String(row.servicetrade_id));
      if (!jobId) continue;
      jobIds.push(jobId);
      const notes = Array.isArray(row.payload?.notes) ? row.payload.notes : [];
      for (const n of notes) {
        const mapped = normalize.normalizeJobNote(n, { companyId, jobId });
        if (mapped) rows.push({ company_id: mapped.companyId, job_id: mapped.jobId, type: mapped.type, text: mapped.text });
      }
    }
    if (jobIds.length) {
      await db.query("DELETE FROM job_notes WHERE company_id = $1 AND job_id = ANY($2::int[])", [companyId, jobIds]);
    }
    await bulkInsertPlain("job_notes", ["company_id", "job_id", "type", "text"], rows);
    logger.info("ServiceTradeProvider: normalized job notes", { companyId, count: rows.length });
    return rows.length;
  }

  async _normalizeAppointments(companyId, engine = null, rawAppointments = null) {
    const raw = rawAppointments || (await db.fetchAllByCompanyChunked(companyId, "servicetrade_appointments"));
    const [jobsMap, techniciansMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "jobs"),
      db.fetchExternalRefMap(companyId, "technicians"),
    ]);
    const argsList = raw
      .map((row) => {
        const jobId        = row.servicetrade_job_id        != null ? (jobsMap.get(String(row.servicetrade_job_id))               ?? null) : null;
        const technicianId = row.servicetrade_technician_id != null ? (techniciansMap.get(String(row.servicetrade_technician_id)) ?? null) : null;
        return normalize.normalizeAppointment(row, { companyId, jobId, technicianId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("appointments", APPOINTMENT_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized appointments", { companyId, count: argsList.length });
    return argsList.length;
  }

  /**
   * Junction: appointment ↔ technicians (FULL techs[] list). Reads `techs[]`
   * embedded in servicetrade_appointments.payload — `appointments.technician_id`
   * (the single-column FK) already carries only the first/primary tech.
   */
  async _normalizeAppointmentTechnicians(companyId, rawAppointments = null) {
    const raw = rawAppointments || (await db.fetchAllByCompanyChunked(companyId, "servicetrade_appointments", { columns: "id, servicetrade_id, payload" }));
    const [appointmentsMap, techniciansMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "appointments"),
      db.fetchExternalRefMap(companyId, "technicians"),
    ]);
    const pairs = [];
    for (const row of raw) {
      const appointmentId = appointmentsMap.get(String(row.servicetrade_id));
      if (!appointmentId) continue;
      const techs = Array.isArray(row.payload?.techs) ? row.payload.techs : [];
      for (const t of techs) {
        if (t?.id == null) continue;
        const technicianId = techniciansMap.get(String(t.id));
        if (technicianId) pairs.push([appointmentId, technicianId]);
      }
    }
    await bulkInsertJunction("appointment_technicians", "appointment_id", "technician_id", pairs);
  }

  /** Junction: appointment ↔ offices. Reads `offices[]` embedded in servicetrade_appointments.payload. */
  async _normalizeAppointmentOffices(companyId, rawAppointments = null) {
    const raw = rawAppointments || (await db.fetchAllByCompanyChunked(companyId, "servicetrade_appointments", { columns: "id, servicetrade_id, payload" }));
    const [appointmentsMap, officesMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "appointments"),
      db.fetchExternalRefMap(companyId, "offices"),
    ]);
    const pairs = [];
    for (const row of raw) {
      const appointmentId = appointmentsMap.get(String(row.servicetrade_id));
      if (!appointmentId) continue;
      const offices = Array.isArray(row.payload?.offices) ? row.payload.offices : [];
      for (const o of offices) {
        if (o?.id == null) continue;
        const officeId = officesMap.get(String(o.id));
        if (officeId) pairs.push([appointmentId, officeId]);
      }
    }
    await bulkInsertJunction("appointment_offices", "appointment_id", "office_id", pairs);
  }

  /**
   * appointment.notes[] ({type, text}) → platform `appointment_notes`. Same
   * no-id, delete-and-reinsert pattern as _normalizeJobNotes.
   */
  async _normalizeAppointmentNotes(companyId, rawAppointments = null) {
    const raw = rawAppointments || (await db.fetchAllByCompanyChunked(companyId, "servicetrade_appointments", { columns: "id, servicetrade_id, payload" }));
    const appointmentsMap = await db.fetchExternalRefMap(companyId, "appointments");
    const appointmentIds = [];
    const rows = [];
    for (const row of raw) {
      const appointmentId = appointmentsMap.get(String(row.servicetrade_id));
      if (!appointmentId) continue;
      appointmentIds.push(appointmentId);
      const notes = Array.isArray(row.payload?.notes) ? row.payload.notes : [];
      for (const n of notes) {
        const mapped = normalize.normalizeAppointmentNote(n, { companyId, appointmentId });
        if (mapped) rows.push({ company_id: mapped.companyId, appointment_id: mapped.appointmentId, type: mapped.type, text: mapped.text });
      }
    }
    if (appointmentIds.length) {
      await db.query("DELETE FROM appointment_notes WHERE company_id = $1 AND appointment_id = ANY($2::int[])", [companyId, appointmentIds]);
    }
    await bulkInsertPlain("appointment_notes", ["company_id", "appointment_id", "type", "text"], rows);
    logger.info("ServiceTradeProvider: normalized appointment notes", { companyId, count: rows.length });
    return rows.length;
  }

  async _normalizeServiceLines(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_service_lines");
    const argsList = raw.map((row) => normalize.normalizeServiceLine(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("service_lines", SERVICE_LINE_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized service lines", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeDeficiencies(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_deficiencies");
    const argsList = raw.map((row) => normalize.normalizeDeficiency(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("deficiencies", DEFICIENCY_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized deficiencies", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeChangeOrders(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_change_orders");
    const argsList = raw.map((row) => normalize.normalizeChangeOrder(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("change_orders", CHANGE_ORDER_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized change orders", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeContracts(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_contracts");
    const argsList = raw.map((row) => normalize.normalizeContract(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("contracts", CONTRACT_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized contracts", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeServiceRecurrences(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_service_recurrences");
    const argsList = raw.map((row) => normalize.normalizeServiceRecurrence(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("service_recurrences", SERVICE_RECURRENCE_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized service recurrences", { companyId, count: argsList.length });
    return argsList.length;
  }

  /**
   * servicetrade_service_requests → platform `service_requests`. Covers
   * EVERY request, job-linked or not — service_opportunities (below) is
   * derived from this table's jobless subset rather than reading the raw
   * table directly.
   */
  async _normalizeServiceRequests(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_service_requests");
    const [locationsMap, jobsMap, deficienciesMap, changeOrdersMap, contractsMap, recurrencesMap, serviceLinesMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "locations"),
      db.fetchExternalRefMap(companyId, "jobs"),
      db.fetchExternalRefMap(companyId, "deficiencies"),
      db.fetchExternalRefMap(companyId, "change_orders"),
      db.fetchExternalRefMap(companyId, "contracts"),
      db.fetchExternalRefMap(companyId, "service_recurrences"),
      db.fetchExternalRefMap(companyId, "service_lines"),
    ]);
    const argsList = raw
      .map((row) => {
        const locationId          = row.servicetrade_location_id     != null ? (locationsMap.get(String(row.servicetrade_location_id))         ?? null) : null;
        const jobId               = row.servicetrade_job_id          != null ? (jobsMap.get(String(row.servicetrade_job_id))                     ?? null) : null;
        const deficiencyId        = row.servicetrade_deficiency_id   != null ? (deficienciesMap.get(String(row.servicetrade_deficiency_id))     ?? null) : null;
        const changeOrderId       = row.servicetrade_change_order_id != null ? (changeOrdersMap.get(String(row.servicetrade_change_order_id))   ?? null) : null;
        const contractId          = row.servicetrade_contract_id     != null ? (contractsMap.get(String(row.servicetrade_contract_id))          ?? null) : null;
        const serviceRecurrenceId = row.servicetrade_recurrence_id   != null ? (recurrencesMap.get(String(row.servicetrade_recurrence_id))       ?? null) : null;
        const serviceLineId       = row.servicetrade_service_line_id != null ? (serviceLinesMap.get(String(row.servicetrade_service_line_id))    ?? null) : null;
        return normalize.normalizeServiceRequest(row, {
          companyId, locationId, jobId, deficiencyId, changeOrderId, contractId, serviceRecurrenceId, serviceLineId,
        });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("service_requests", SERVICE_REQUEST_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized service requests", { companyId, count: argsList.length });
    return argsList.length;
  }

  /**
   * Junction: service_request ↔ preferred technicians. Reads `preferredTechs[]`
   * already embedded in servicetrade_service_requests.payload — no extra API
   * call. Covers every request (unlike _normalizeServiceOpportunityPreferredTechs,
   * which only covers the jobless subset).
   */
  async _normalizeServiceRequestPreferredTechs(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_service_requests", { columns: "id, servicetrade_id, payload" });
    const [requestsMap, techniciansMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "service_requests"),
      db.fetchExternalRefMap(companyId, "technicians"),
    ]);
    const pairs = [];
    for (const row of raw) {
      const serviceRequestId = requestsMap.get(String(row.servicetrade_id));
      if (!serviceRequestId) continue;
      const techs = Array.isArray(row.payload?.preferredTechs) ? row.payload.preferredTechs : [];
      for (const t of techs) {
        if (t?.id == null) continue;
        const technicianId = techniciansMap.get(String(t.id));
        if (technicianId) pairs.push([serviceRequestId, technicianId]);
      }
    }
    await bulkInsertJunction("service_request_preferred_techs", "service_request_id", "technician_id", pairs);
  }

  /**
   * Qualification rule (unchanged): a service request becomes a
   * service_opportunity only when it has NEITHER a job NOR an appointment —
   * i.e. `job_id IS NULL` on the platform `service_requests` row. Every FK id
   * on that row is already a resolved platform id (it went through
   * _normalizeServiceRequests first), so this just reshapes rows — no
   * external_ref resolution needed here.
   */
  async _normalizeServiceOpportunities(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM service_requests WHERE company_id = $1 AND job_id IS NULL",
      [companyId]
    );
    const argsList = raw.map((row) => normalize.normalizeServiceOpportunity(row)).filter(Boolean);
    await db.bulkUpsertByExternalRef("service_opportunities", SERVICE_OPPORTUNITY_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized service opportunities", { companyId, count: argsList.length });
    return argsList.length;
  }

  /**
   * servicetrade_service_requests (the subset attached to an appointment, i.e.
   * servicetrade_appointment_id IS NOT NULL) → platform `appointment_services`.
   * Distinct from _normalizeServiceOpportunities (job-less only, sales-pipeline
   * semantics) — this covers the OPPOSITE case: requests that DO have a job/
   * appointment, whose service/service-line context would otherwise never
   * reach any platform table.
   */
  async _normalizeAppointmentServices(companyId, engine = null) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_service_requests", {
      extraWhere: "servicetrade_appointment_id IS NOT NULL",
    });
    const [appointmentsMap, jobsMap, serviceLinesMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "appointments"),
      db.fetchExternalRefMap(companyId, "jobs"),
      db.fetchExternalRefMap(companyId, "service_lines"),
    ]);
    const argsList = raw
      .map((row) => {
        const appointmentId = row.servicetrade_appointment_id != null ? (appointmentsMap.get(String(row.servicetrade_appointment_id)) ?? null) : null;
        const jobId         = row.servicetrade_job_id          != null ? (jobsMap.get(String(row.servicetrade_job_id))                   ?? null) : null;
        const serviceLineId = row.servicetrade_service_line_id != null ? (serviceLinesMap.get(String(row.servicetrade_service_line_id))  ?? null) : null;
        return normalize.normalizeAppointmentService(row, { companyId, appointmentId, jobId, serviceLineId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("appointment_services", APPOINTMENT_SERVICE_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized appointment services", { companyId, count: argsList.length });
    return argsList.length;
  }

  /**
   * Junction: service_opportunity ↔ preferred technicians. Reads
   * `preferredTechs[]` already embedded in servicetrade_service_requests.payload
   * — no extra API call.
   */
  async _normalizeServiceOpportunityPreferredTechs(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "servicetrade_service_requests", { columns: "id, servicetrade_id, payload" });
    const [opportunitiesMap, techniciansMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "service_opportunities"),
      db.fetchExternalRefMap(companyId, "technicians"),
    ]);
    const pairs = [];
    for (const row of raw) {
      const opportunityId = opportunitiesMap.get(String(row.servicetrade_id));
      if (!opportunityId) continue; // not an opportunity (had a job) — no junction rows to write
      const techs = Array.isArray(row.payload?.preferredTechs) ? row.payload.preferredTechs : [];
      for (const t of techs) {
        if (t?.id == null) continue;
        const technicianId = techniciansMap.get(String(t.id));
        if (technicianId) pairs.push([opportunityId, technicianId]);
      }
    }
    await bulkInsertJunction("service_opportunity_preferred_techs", "service_opportunity_id", "technician_id", pairs);
  }

  // ── Normalizers (delegate to pure mappers) ─────────────────────────────────

  normalizeCustomer(raw, ctx)    { return normalize.normalizeCustomer(raw, ctx); }
  normalizeJob(raw, ctx)         { return normalize.normalizeJob(raw, ctx); }
  normalizeAppointment(raw, ctx) { return normalize.normalizeAppointment(raw, ctx); }
  normalizeTechnician(raw, ctx)  { return normalize.normalizeTechnician(raw, ctx); }
  normalizeProject(raw, ctx)              { return normalize.normalizeProject(raw, ctx); }
  normalizeCrmUser(raw, ctx)               { return normalize.normalizeCrmUser(raw, ctx); }
  normalizeSchedulingComment(raw, ctx)     { return normalize.normalizeSchedulingComment(raw, ctx); }
  normalizeJobNote(raw, ctx)               { return normalize.normalizeJobNote(raw, ctx); }
  normalizeAppointmentNote(raw, ctx)       { return normalize.normalizeAppointmentNote(raw, ctx); }
  normalizeContact(raw, ctx)     { return normalize.normalizeContact(raw, ctx); }
  normalizeOffice(raw, ctx)      { return normalize.normalizeOffice(raw, ctx); }
  normalizeTag(raw, ctx)         { return normalize.normalizeTag(raw, ctx); }
  normalizeLocation(raw, ctx)    { return normalize.normalizeLocation(raw, ctx); }
  normalizeServiceLine(raw, ctx)         { return normalize.normalizeServiceLine(raw, ctx); }
  normalizeDeficiency(raw, ctx)          { return normalize.normalizeDeficiency(raw, ctx); }
  normalizeChangeOrder(raw, ctx)         { return normalize.normalizeChangeOrder(raw, ctx); }
  normalizeContract(raw, ctx)            { return normalize.normalizeContract(raw, ctx); }
  normalizeServiceRecurrence(raw, ctx)   { return normalize.normalizeServiceRecurrence(raw, ctx); }
  normalizeServiceRequest(raw, ctx)      { return normalize.normalizeServiceRequest(raw, ctx); }
  normalizeServiceOpportunity(raw, ctx)  { return normalize.normalizeServiceOpportunity(raw, ctx); }
  normalizeAppointmentService(raw, ctx)  { return normalize.normalizeAppointmentService(raw, ctx); }
}

/**
 * Bulk-insert junction pairs, chunked, ON CONFLICT DO NOTHING. `pairs` is an
 * array of [valueA, valueB] tuples already resolved to platform ids.
 */
/**
 * Collapse raw ServiceTrade contacts that are the same person.
 *
 * ServiceTrade routinely holds several contact records with distinct ids but
 * the same email address — typically one per location for a shared role inbox
 * (e.g. 7 separate "Accounts Payable" records all at ap@goodwillomaha.org).
 * Treating them as separate people made a single job list the same person over
 * and over, so email (case/whitespace-insensitive) is the identity key.
 *
 * A contact with no email cannot be matched this way and is always kept as its
 * own person — never merged on name, since unrelated people share names far
 * more often than they share an inbox.
 *
 * The surviving record is the LOWEST servicetrade_id in the group: it must be
 * stable across syncs, because it becomes the `external_ref` every FK resolves
 * through. Field values are merged in id order (first non-empty wins), so a
 * phone number present on only one duplicate isn't lost.
 *
 * @returns {{canonicalRows: Array<object>, alias: Map<string,string>, dropped: string[]}}
 *   `alias` maps EVERY servicetrade_id (including canonical ones) to its
 *   canonical servicetrade_id; `dropped` lists the non-canonical ids, whose
 *   now-superseded platform rows the caller deletes.
 */
function dedupeContactsByEmail(rawContacts) {
  const MERGEABLE = [
    "first_name", "last_name", "phone", "mobile", "alternate_phone",
    "email", "type", "status", "types", "external_ids",
  ];
  const isEmpty = (v) => v == null || (typeof v === "string" && v.trim() === "");

  const groups = new Map(); // key -> rows[]
  for (const row of rawContacts) {
    const email = typeof row.email === "string" ? row.email.trim().toLowerCase() : "";
    // Unique key per row when there's no email — i.e. never grouped.
    const key = email || `no-email:${row.servicetrade_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const canonicalRows = [];
  const alias = new Map();
  const dropped = [];
  for (const rows of groups.values()) {
    rows.sort((a, b) => (BigInt(a.servicetrade_id) < BigInt(b.servicetrade_id) ? -1 : 1));
    const canonical = { ...rows[0] };
    for (const dup of rows.slice(1)) {
      for (const field of MERGEABLE) {
        if (isEmpty(canonical[field]) && !isEmpty(dup[field])) canonical[field] = dup[field];
      }
      dropped.push(String(dup.servicetrade_id));
      alias.set(String(dup.servicetrade_id), String(canonical.servicetrade_id));
    }
    alias.set(String(canonical.servicetrade_id), String(canonical.servicetrade_id));
    canonicalRows.push(canonical);
  }
  return { canonicalRows, alias, dropped };
}

async function bulkInsertJunction(table, colA, colB, pairs, { batchSize = 1000 } = {}) {
  if (!pairs.length) return;
  let queryCount = 0;
  for (let i = 0; i < pairs.length; i += batchSize) {
    const chunk = pairs.slice(i, i + batchSize);
    const values = [];
    const params = [];
    let idx = 0;
    for (const [a, b] of chunk) {
      values.push(`($${++idx}, $${++idx})`);
      params.push(a, b);
    }
    await db.query(
      `INSERT INTO ${table} (${colA}, ${colB}) VALUES ${values.join(", ")}
       ON CONFLICT (${colA}, ${colB}) DO NOTHING`,
      params
    );
    queryCount++;
  }
  logger.info("bulkInsertJunction: table upserted", { table, pairs: pairs.length, batchSize, queries: queryCount });
}

/**
 * Plain bulk INSERT (no upsert/conflict handling) for rows with no stable
 * external identity to key an upsert on — e.g. job/appointment notes, which
 * ServiceTrade never assigns an id to. Callers delete the prior rows for the
 * affected parents first, then re-insert, so this never needs ON CONFLICT.
 */
async function bulkInsertPlain(table, columns, rows, { batchSize = 1000 } = {}) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values = [];
    const params = [];
    let idx = 0;
    for (const row of chunk) {
      values.push(`(${columns.map(() => `$${++idx}`).join(", ")})`);
      params.push(...columns.map((c) => row[c] ?? null));
    }
    await db.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values.join(", ")}`, params);
  }
}

// ── Field descriptors for db.bulkUpsertByExternalRef (column, args key, jsonb?, transform?, updateExpr?) ──

const CUSTOMER_FIELDS = [
  { column: "full_name", key: "fullName" },
  { column: "email", key: "email" },
  { column: "phone", key: "phone", updateExpr: "phone = COALESCE(EXCLUDED.phone, customers.phone)" },
  { column: "address_line1", key: "addressLine1" },
  { column: "city", key: "city" },
  { column: "state", key: "state" },
  { column: "zipcode", key: "zipcode" },
  { column: "country", key: "country", transform: (v) => v || "US" },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const JOB_FIELDS = [
  { column: "customer_id", key: "customerId" },
  { column: "title", key: "title" },
  { column: "description", key: "description" },
  { column: "job_type", key: "jobType" },
  { column: "status", key: "status", transform: (v) => v || "open" },
  { column: "scheduled_date", key: "scheduledDate" },
  { column: "scheduled_window_start", key: "scheduledWindowStart" },
  { column: "scheduled_window_end", key: "scheduledWindowEnd" },
  { column: "job_number", key: "jobNumber" },
  { column: "owner_id", key: "ownerId" },
  { column: "salesperson_id", key: "salespersonId" },
  { column: "assigned_office_id", key: "assignedOfficeId" },
  { column: "project_id", key: "projectId" },
  { column: "contract_id", key: "contractId" },
  { column: "current_appointment_id", key: "currentAppointmentId" },
  { column: "location_id", key: "locationId" },
  { column: "primary_contact_id", key: "primaryContactId" },
  { column: "external_ids", key: "externalIds", jsonb: true },
];

const APPOINTMENT_FIELDS = [
  { column: "job_id", key: "jobId" },
  { column: "technician_id", key: "technicianId" },
  { column: "status", key: "status", transform: (v) => v || "scheduled" },
  { column: "scheduled_start", key: "scheduledStart" },
  { column: "scheduled_end", key: "scheduledEnd" },
  { column: "duration", key: "duration" },
  { column: "released", key: "released" },
];

const CRM_USER_FIELDS = [
  { column: "name", key: "name" },
  { column: "email", key: "email" },
  { column: "status", key: "status" },
  { column: "is_tech", key: "isTech" },
  { column: "is_helper", key: "isHelper" },
];

const PROJECT_FIELDS = [
  { column: "start_date", key: "startDate" },
  { column: "end_date", key: "endDate" },
];

const SCHEDULING_COMMENT_FIELDS = [
  { column: "job_id", key: "jobId" },
  { column: "content", key: "content" },
];

const CONTACT_FIELDS = [
  { column: "first_name", key: "firstName" },
  { column: "contact_role", key: "contactRole", transform: (v) => v || "general" },
  { column: "last_name", key: "lastName" },
  { column: "phone", key: "phone" },
  { column: "mobile", key: "mobile" },
  { column: "alternate_phone", key: "alternatePhone" },
  { column: "email", key: "email" },
  { column: "type", key: "type" },
  { column: "status", key: "status" },
  { column: "types", key: "types", jsonb: true },
  { column: "external_ids", key: "externalIds", jsonb: true },
];

const OFFICE_FIELDS = [
  { column: "name", key: "name" },
  { column: "address_line1", key: "addressLine1" },
  { column: "city", key: "city" },
  { column: "state", key: "state" },
  { column: "zipcode", key: "zipcode" },
  { column: "country", key: "country", transform: (v) => v || "US" },
  { column: "lat", key: "lat" },
  { column: "lon", key: "lon" },
  { column: "phone", key: "phone" },
  { column: "email", key: "email" },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const TAG_FIELDS = [
  { column: "name", key: "name" },
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

const SERVICE_LINE_FIELDS = [
  { column: "name", key: "name" },
  { column: "trade", key: "trade" },
  { column: "abbr", key: "abbr" },
  { column: "icon", key: "icon" },
];

const DEFICIENCY_FIELDS = [
  { column: "ref_number", key: "refNumber" },
  { column: "name", key: "name" },
  { column: "description", key: "description" },
];

const CHANGE_ORDER_FIELDS = [
  { column: "status", key: "status" },
  { column: "type", key: "type" },
  { column: "reference_number", key: "referenceNumber" },
];

const CONTRACT_FIELDS = [
  { column: "name", key: "name" },
];

const SERVICE_RECURRENCE_FIELDS = [
  { column: "description", key: "description" },
  { column: "frequency", key: "frequency" },
  { column: "recurrence_interval", key: "recurrenceInterval" },
  { column: "repeat_weekday", key: "repeatWeekday" },
];

const SERVICE_REQUEST_FIELDS = [
  { column: "job_id", key: "jobId" },
  { column: "location_id", key: "locationId" },
  { column: "service_line_id", key: "serviceLineId" },
  { column: "deficiency_id", key: "deficiencyId" },
  { column: "change_order_id", key: "changeOrderId" },
  { column: "contract_id", key: "contractId" },
  { column: "service_recurrence_id", key: "serviceRecurrenceId" },
  { column: "status", key: "status" },
  { column: "description", key: "description" },
  { column: "window_start", key: "windowStart" },
  { column: "window_end", key: "windowEnd" },
  { column: "closed_on", key: "closedOn" },
  { column: "estimated_price", key: "estimatedPrice" },
  { column: "duration", key: "duration" },
  { column: "preferred_start_time", key: "preferredStartTime" },
  { column: "budget", key: "budget", jsonb: true },
  { column: "preferred_vendor", key: "preferredVendor", jsonb: true },
  { column: "asset", key: "asset", jsonb: true },
  { column: "visibility", key: "visibility", jsonb: true },
];

const SERVICE_OPPORTUNITY_FIELDS = [
  { column: "location_id", key: "locationId" },
  { column: "job_id", key: "jobId" },
  { column: "deficiency_id", key: "deficiencyId" },
  { column: "change_order_id", key: "changeOrderId" },
  { column: "contract_id", key: "contractId" },
  { column: "service_recurrence_id", key: "serviceRecurrenceId" },
  { column: "service_line_id", key: "serviceLineId" },
  { column: "status", key: "status" },
  { column: "description", key: "description" },
  { column: "window_start", key: "windowStart" },
  { column: "window_end", key: "windowEnd" },
  { column: "closed_on", key: "closedOn" },
  { column: "estimated_price", key: "estimatedPrice" },
  { column: "duration", key: "duration" },
  { column: "preferred_start_time", key: "preferredStartTime" },
  { column: "budget", key: "budget", jsonb: true },
  { column: "preferred_vendor", key: "preferredVendor", jsonb: true },
  { column: "asset", key: "asset", jsonb: true },
  { column: "visibility", key: "visibility", jsonb: true },
];

const APPOINTMENT_SERVICE_FIELDS = [
  { column: "appointment_id", key: "appointmentId" },
  { column: "job_id", key: "jobId" },
  { column: "service_line_id", key: "serviceLineId" },
  { column: "status", key: "status" },
  { column: "completion", key: "completion" },
  { column: "description", key: "description" },
  { column: "window_start", key: "windowStart" },
  { column: "window_end", key: "windowEnd" },
  { column: "duration", key: "duration" },
  { column: "estimated_price", key: "estimatedPrice" },
  { column: "asset", key: "asset", jsonb: true },
];

/**
 * Identity for synced customers is (company_id, external_ref, source) only —
 * phone is never a matching/dedup key. Two genuinely distinct ServiceTrade
 * customers can share a phone (e.g. multiple locations routed through one
 * central office line), so matching by phone risked silently merging two
 * different real customers' data together. Plain bulk upsert, no fallback.
 */
async function bulkUpsertCustomers(companyId, argsList) {
  if (!argsList.length) return 0;
  await db.bulkUpsertByExternalRef("customers", CUSTOMER_FIELDS, argsList);
  return argsList.length;
}

module.exports = new ServiceTradeProvider();
