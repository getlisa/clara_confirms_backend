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
  get supportedEntities() {
    return [
      "customers", "jobs", "appointments", "technicians", "contacts", "offices", "tags", "locations",
      "service_lines", "deficiencies", "change_orders", "contracts", "service_recurrences", "service_opportunities",
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
      customers: 0, technicians: 0, jobs: 0, appointments: 0, contacts: 0, offices: 0, tags: 0, locations: 0,
      serviceLines: 0, deficiencies: 0, changeOrders: 0, contracts: 0, serviceRecurrences: 0, serviceOpportunities: 0,
      appointmentServices: 0,
    };

    counts.customers   = await this._normalizeCustomers(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "customers", count: counts.customers });

    counts.contacts    = await this._normalizeContacts(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "contacts", count: counts.contacts });

    counts.offices     = await this._normalizeOffices(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "offices", count: counts.offices });

    counts.tags        = await this._normalizeTags(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "tags", count: counts.tags });

    counts.locations   = await this._normalizeLocations(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "locations", count: counts.locations });

    await this._normalizeLocationOffices(companyId);
    await this._normalizeLocationTags(companyId);
    await this._normalizeContactJunctions(companyId);

    counts.technicians = await this._normalizeTechnicians(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "technicians", count: counts.technicians });

    counts.jobs        = await this._normalizeJobs(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "jobs", count: counts.jobs });

    counts.appointments = await this._normalizeAppointments(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "appointments", count: counts.appointments });

    // Service-request-derived entities — independent of each other, so order
    // among them doesn't matter, but all must run before service_opportunities
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

    counts.serviceOpportunities = await this._normalizeServiceOpportunities(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "service_opportunities", count: counts.serviceOpportunities });

    await this._normalizeServiceOpportunityPreferredTechs(companyId);

    counts.appointmentServices = await this._normalizeAppointmentServices(companyId, engine);
    if (engine) await engine.emit("entity_done", { entity: "appointment_services", count: counts.appointmentServices });

    return counts;
  }

  async _normalizeCustomers(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_customers WHERE company_id = $1",
      [companyId]
    );
    const argsList = raw.map((row) => normalize.normalizeCustomer(row, { companyId })).filter(Boolean);
    const n = await bulkUpsertCustomers(companyId, argsList);
    logger.info("ServiceTradeProvider: normalized customers", { companyId, count: n });
    return n;
  }

  async _normalizeContacts(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_contacts WHERE company_id = $1",
      [companyId]
    );
    const argsList = raw.map((row) => normalize.normalizeContact(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("contacts", CONTACT_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized contacts", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeOffices(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_offices WHERE company_id = $1",
      [companyId]
    );
    const argsList = raw.map((row) => normalize.normalizeOffice(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("offices", OFFICE_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized offices", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeTags(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_tags WHERE company_id = $1",
      [companyId]
    );
    const argsList = raw.map((row) => normalize.normalizeTag(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("tags", TAG_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized tags", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeLocations(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_locations WHERE company_id = $1",
      [companyId]
    );
    // Bulk-fetch both FK maps ONCE instead of one lookup query per row.
    const [customersMap, contactsMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "customers"),
      db.fetchExternalRefMap(companyId, "contacts"),
    ]);
    const argsList = raw
      .map((row) => {
        const customerId       = row.servicetrade_customer_id       != null ? (customersMap.get(String(row.servicetrade_customer_id))       ?? null) : null;
        const primaryContactId = row.servicetrade_primary_contact_id != null ? (contactsMap.get(String(row.servicetrade_primary_contact_id)) ?? null) : null;
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
    const { rows: raw } = await db.query(
      "SELECT servicetrade_id, payload FROM servicetrade_locations WHERE company_id = $1",
      [companyId]
    );
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
    const { rows: raw } = await db.query(
      "SELECT servicetrade_id, payload FROM servicetrade_locations WHERE company_id = $1",
      [companyId]
    );
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
  async _normalizeContactJunctions(companyId) {
    const { rows: raw } = await db.query(
      "SELECT servicetrade_id, payload FROM servicetrade_contacts WHERE company_id = $1",
      [companyId]
    );
    const [contactsMap, locationsMap, customersMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "contacts"),
      db.fetchExternalRefMap(companyId, "locations"),
      db.fetchExternalRefMap(companyId, "customers"),
    ]);
    const locationPairs = [];
    const companyPairs = [];
    for (const row of raw) {
      const contactId = contactsMap.get(String(row.servicetrade_id));
      if (!contactId) continue;

      const locations = Array.isArray(row.payload?.locations) ? row.payload.locations
                       : row.payload?.location ? [row.payload.location] : [];
      for (const l of locations) {
        if (l?.id == null) continue;
        const locationId = locationsMap.get(String(l.id));
        if (locationId) locationPairs.push([contactId, locationId]);
      }

      const companiesArr = Array.isArray(row.payload?.companies) ? row.payload.companies
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
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_technicians WHERE company_id = $1",
      [companyId]
    );
    const argsList = raw.map((row) => normalize.normalizeTechnician(row, { companyId })).filter(Boolean);
    const n = await techDb.bulkUpsertByExternalRef(companyId, argsList);
    logger.info("ServiceTradeProvider: normalized technicians", { companyId, count: n });
    return n;
  }

  async _normalizeJobs(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_jobs WHERE company_id = $1",
      [companyId]
    );
    const customersMap = await db.fetchExternalRefMap(companyId, "customers");
    const argsList = raw
      .map((row) => {
        const customerId = row.servicetrade_customer_id != null ? (customersMap.get(String(row.servicetrade_customer_id)) ?? null) : null;
        return normalize.normalizeJob(row, { companyId, customerId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("jobs", JOB_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized jobs", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeAppointments(companyId, engine = null) {
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_appointments WHERE company_id = $1",
      [companyId]
    );
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

  async _normalizeServiceLines(companyId, engine = null) {
    const { rows: raw } = await db.query("SELECT * FROM servicetrade_service_lines WHERE company_id = $1", [companyId]);
    const argsList = raw.map((row) => normalize.normalizeServiceLine(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("service_lines", SERVICE_LINE_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized service lines", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeDeficiencies(companyId, engine = null) {
    const { rows: raw } = await db.query("SELECT * FROM servicetrade_deficiencies WHERE company_id = $1", [companyId]);
    const argsList = raw.map((row) => normalize.normalizeDeficiency(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("deficiencies", DEFICIENCY_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized deficiencies", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeChangeOrders(companyId, engine = null) {
    const { rows: raw } = await db.query("SELECT * FROM servicetrade_change_orders WHERE company_id = $1", [companyId]);
    const argsList = raw.map((row) => normalize.normalizeChangeOrder(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("change_orders", CHANGE_ORDER_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized change orders", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeContracts(companyId, engine = null) {
    const { rows: raw } = await db.query("SELECT * FROM servicetrade_contracts WHERE company_id = $1", [companyId]);
    const argsList = raw.map((row) => normalize.normalizeContract(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("contracts", CONTRACT_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized contracts", { companyId, count: argsList.length });
    return argsList.length;
  }

  async _normalizeServiceRecurrences(companyId, engine = null) {
    const { rows: raw } = await db.query("SELECT * FROM servicetrade_service_recurrences WHERE company_id = $1", [companyId]);
    const argsList = raw.map((row) => normalize.normalizeServiceRecurrence(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("service_recurrences", SERVICE_RECURRENCE_FIELDS, argsList);
    logger.info("ServiceTradeProvider: normalized service recurrences", { companyId, count: argsList.length });
    return argsList.length;
  }

  /**
   * Qualification rule: a service request becomes a service_opportunity only
   * when it has NEITHER a job NOR an appointment — i.e. servicetrade_job_id
   * is null on the raw row. (A request with a job but no appointment yet
   * does not qualify under this rule.) All other service requests are still
   * fully synced into servicetrade_service_requests + their fanned-out
   * entities above — they just don't get a service_opportunities row.
   */
  async _normalizeServiceOpportunities(companyId, engine = null) {
    const { rows: raw } = await db.query("SELECT * FROM servicetrade_service_requests WHERE company_id = $1", [companyId]);
    const [locationsMap, deficienciesMap, changeOrdersMap, contractsMap, recurrencesMap, serviceLinesMap] = await Promise.all([
      db.fetchExternalRefMap(companyId, "locations"),
      db.fetchExternalRefMap(companyId, "deficiencies"),
      db.fetchExternalRefMap(companyId, "change_orders"),
      db.fetchExternalRefMap(companyId, "contracts"),
      db.fetchExternalRefMap(companyId, "service_recurrences"),
      db.fetchExternalRefMap(companyId, "service_lines"),
    ]);
    const argsList = raw
      .filter((row) => !row.servicetrade_job_id) // has a job — does not qualify as an opportunity
      .map((row) => {
        const locationId          = row.servicetrade_location_id     != null ? (locationsMap.get(String(row.servicetrade_location_id))         ?? null) : null;
        const deficiencyId        = row.servicetrade_deficiency_id   != null ? (deficienciesMap.get(String(row.servicetrade_deficiency_id))     ?? null) : null;
        const changeOrderId       = row.servicetrade_change_order_id != null ? (changeOrdersMap.get(String(row.servicetrade_change_order_id))   ?? null) : null;
        const contractId          = row.servicetrade_contract_id     != null ? (contractsMap.get(String(row.servicetrade_contract_id))          ?? null) : null;
        const serviceRecurrenceId = row.servicetrade_recurrence_id   != null ? (recurrencesMap.get(String(row.servicetrade_recurrence_id))       ?? null) : null;
        const serviceLineId       = row.servicetrade_service_line_id != null ? (serviceLinesMap.get(String(row.servicetrade_service_line_id))    ?? null) : null;
        return normalize.normalizeServiceOpportunity(row, {
          companyId, locationId, jobId: null, deficiencyId, changeOrderId, contractId, serviceRecurrenceId, serviceLineId,
        });
      })
      .filter(Boolean);
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
    const { rows: raw } = await db.query(
      "SELECT * FROM servicetrade_service_requests WHERE company_id = $1 AND servicetrade_appointment_id IS NOT NULL",
      [companyId]
    );
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
    const { rows: raw } = await db.query(
      "SELECT servicetrade_id, payload FROM servicetrade_service_requests WHERE company_id = $1",
      [companyId]
    );
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
  normalizeContact(raw, ctx)     { return normalize.normalizeContact(raw, ctx); }
  normalizeOffice(raw, ctx)      { return normalize.normalizeOffice(raw, ctx); }
  normalizeTag(raw, ctx)         { return normalize.normalizeTag(raw, ctx); }
  normalizeLocation(raw, ctx)    { return normalize.normalizeLocation(raw, ctx); }
  normalizeServiceLine(raw, ctx)         { return normalize.normalizeServiceLine(raw, ctx); }
  normalizeDeficiency(raw, ctx)          { return normalize.normalizeDeficiency(raw, ctx); }
  normalizeChangeOrder(raw, ctx)         { return normalize.normalizeChangeOrder(raw, ctx); }
  normalizeContract(raw, ctx)            { return normalize.normalizeContract(raw, ctx); }
  normalizeServiceRecurrence(raw, ctx)   { return normalize.normalizeServiceRecurrence(raw, ctx); }
  normalizeServiceOpportunity(raw, ctx)  { return normalize.normalizeServiceOpportunity(raw, ctx); }
  normalizeAppointmentService(raw, ctx)  { return normalize.normalizeAppointmentService(raw, ctx); }
}

/**
 * Bulk-insert junction pairs, chunked, ON CONFLICT DO NOTHING. `pairs` is an
 * array of [valueA, valueB] tuples already resolved to platform ids.
 */
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
];

const APPOINTMENT_FIELDS = [
  { column: "job_id", key: "jobId" },
  { column: "technician_id", key: "technicianId" },
  { column: "status", key: "status", transform: (v) => v || "scheduled" },
  { column: "scheduled_start", key: "scheduledStart" },
  { column: "scheduled_end", key: "scheduledEnd" },
];

const CONTACT_FIELDS = [
  { column: "first_name", key: "firstName" },
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
