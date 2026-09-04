/**
 * InspectPointProvider — concrete CrmProvider implementation.
 *
 * Same two-step pipeline as ServiceTradeProvider (RAW SYNC then NORMALIZE),
 * but the normalize step is structurally simpler: six flat raw tables, no
 * compound/side-loaded documents, no offices/tags/crm_users/projects/service_lines
 * — those ServiceTrade concepts have no InspectPoint equivalent and are left
 * out entirely rather than stubbed.
 */

const { CrmProvider } = require("../base");
const ip = require("../../inspectpoint");
const ipSync = require("../../inspectpoint-sync");
const ipCredsDb = require("../../../db/inspectpoint-credentials");
const db = require("../../../db");
const normalize = require("./normalize");
const { replaceJunction } = require("../shared/junctions");
const todosDb = require("../../../db/todos");
const logger = require("../../../utils/logger");

const SOURCE = "inspectpoint";
const refMap = (companyId, table) => db.fetchExternalRefMap(companyId, table, SOURCE);

function isNumericRef(v) {
  return v != null && v !== "" && /^\d+$/.test(String(v));
}

async function raiseCrmSyncTodo(companyId, { action, entity, entityId, error }) {
  await todosDb
    .create({
      companyId, callId: null,
      type: todosDb.TODO_TYPES.CRM_SYNC,
      isTest: false,
      metadata: { action, entity, entity_id: entityId != null ? String(entityId) : null, error: error ? String(error).slice(0, 2000) : null },
    })
    .catch((err) => logger.warn("inspectpoint crm-sync: failed to raise CRM_SYNC todo", { error: err.message, companyId, action }));
}

/**
 * Per building, which contact (if any) is "the" primary. InspectPoint has no
 * primary-contact field of its own — this is a deterministic heuristic over
 * each contact's building-role assignments: prefer a 'scheduling' role, else
 * 'owner', else the sole contact on that building if there's exactly one,
 * else none. Ties within a role are broken by ascending inspectpoint contact
 * id so the winner is stable run to run regardless of fetch/page order.
 *
 * @returns {Map<number, string>} buildingInspectpointId -> contactExternalRef
 */
function buildPrimaryContactByBuilding(rawContacts) {
  const candidatesByBuilding = new Map();
  for (const row of rawContacts) {
    const p = row.payload || {};
    for (const b of Array.isArray(p.buildings) ? p.buildings : []) {
      if (b?.id == null) continue;
      // Keyed as a STRING. `b.id` is a JSON number, but every lookup against
      // this map uses a raw-table `inspectpoint_id`, which node-postgres hands
      // back as a string because the column is bigint. Keying on the number
      // meant the lookup in _normalizeLocations never matched, so
      // locations.primary_contact_id — and, through it, every job's
      // primary_contact_id — was null for the entire tenant.
      const buildingKey = String(b.id);
      if (!candidatesByBuilding.has(buildingKey)) candidatesByBuilding.set(buildingKey, []);
      candidatesByBuilding.get(buildingKey).push({
        contactId: String(row.inspectpoint_id),
        roles: new Set((Array.isArray(b.roles) ? b.roles : []).map((r) => String(r).toLowerCase())),
      });
    }
  }
  const primaryByBuilding = new Map();
  for (const [buildingId, candidates] of candidatesByBuilding) {
    candidates.sort((a, b) => Number(a.contactId) - Number(b.contactId));
    const winner =
      candidates.find((c) => c.roles.has("scheduling")) ||
      candidates.find((c) => c.roles.has("owner")) ||
      (candidates.length === 1 ? candidates[0] : null);
    if (winner) primaryByBuilding.set(buildingId, winner.contactId);
  }
  return primaryByBuilding;
}

class InspectPointProvider extends CrmProvider {
  get slug() { return "inspectpoint"; }
  get supportedEntities() {
    return ["customers", "locations", "contacts", "technicians", "jobs", "appointments"];
  }

  async getCredentials(companyId) {
    return await ipCredsDb.getByCompanyId(companyId);
  }

  async request(companyId, method, path, opts = {}) {
    const creds = await this.getCredentials(companyId);
    return await ip.request(companyId, method, path, opts, creds);
  }

  // ── CRM write-back mirrors ───────────────────────────────────────────────
  //
  // Both channels (chat's actions.js, voice's retell-tools.js/retell.js)
  // reach these through crm/index.js's getProviderForSource(row.source) —
  // see Phase 3. Self-guard on `source === 'inspectpoint'` the same way
  // ServiceTrade's mirrors do, even though dispatch-by-source should make a
  // mismatched call here unreachable in practice; it's cheap insurance.

  /** Reschedule: PATCH the visit's own scheduled_date — the visit, not the
   * parent inspection, is the dispatch record. */
  async mirrorRescheduleAppointment(companyId, appointment, { scheduledStart, retellCallId = null } = {}) {
    if (!appointment || appointment.source !== SOURCE || !isNumericRef(appointment.external_ref)) {
      return { skipped: "not_inspectpoint" };
    }
    const ref = String(appointment.external_ref);
    const res = await this.request(companyId, "PATCH", `/external/api/v1/inspection_visits/${encodeURIComponent(ref)}`, {
      body: { visit: { scheduled_date: scheduledStart } },
    });
    if (!res.ok) {
      await raiseCrmSyncTodo(companyId, { action: "reschedule_appointment", entity: "inspection_visit", entityId: ref, error: JSON.stringify(res.messages || res.status) });
      return { ok: false, status: res.status };
    }
    return { ok: true };
  }

  /**
   * Cancel: PATCH the parent INSPECTION's status_code to cancelled — there is
   * no clean per-visit cancel in InspectPoint short of DELETE
   * /inspection_visits/{id} (destructive, and would break the raw sync's
   * ability to re-discover it). This means an "appointment_only" scope cancel
   * still cancels the whole inspection on InspectPoint's side, unlike
   * ServiceTrade where the two scopes map to genuinely different writes — a
   * real product compromise forced by the API shape, not an oversight.
   */
  async mirrorCancelAppointment(companyId, appointment, { retellCallId = null } = {}) {
    if (!appointment || appointment.source !== SOURCE) return { skipped: "not_inspectpoint" };
    const { rows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [appointment.job_id, companyId]);
    return this._cancelInspection(companyId, rows[0], { retellCallId, entity: "appointment" });
  }

  async mirrorCancelJob(companyId, job, { retellCallId = null } = {}) {
    return this._cancelInspection(companyId, job, { retellCallId, entity: "job" });
  }

  async _cancelInspection(companyId, job, { retellCallId = null, entity = "job" } = {}) {
    if (!job || job.source !== SOURCE || !isNumericRef(job.external_ref)) return { skipped: "not_inspectpoint" };
    const ref = String(job.external_ref);
    const res = await this.request(companyId, "PATCH", `/external/api/v1/inspections/${encodeURIComponent(ref)}`, {
      body: { inspection: { status_code: "cancelled" } },
    });
    if (!res.ok) {
      await raiseCrmSyncTodo(companyId, { action: `cancel_${entity}`, entity: "inspection", entityId: ref, error: JSON.stringify(res.messages || res.status) });
      return { ok: false, status: res.status };
    }
    return { ok: true };
  }

  /** Reschedule the whole job (voice's reschedule_job tool — chat has no equivalent). */
  async mirrorRescheduleJob(companyId, job, { scheduledDate, retellCallId = null } = {}) {
    if (!job || job.source !== SOURCE || !isNumericRef(job.external_ref)) return { skipped: "not_inspectpoint" };
    const ref = String(job.external_ref);
    const res = await this.request(companyId, "PATCH", `/external/api/v1/inspections/${encodeURIComponent(ref)}`, {
      body: { inspection: { scheduled_date: scheduledDate } },
    });
    if (!res.ok) {
      await raiseCrmSyncTodo(companyId, { action: "reschedule_job", entity: "inspection", entityId: ref, error: JSON.stringify(res.messages || res.status) });
      return { ok: false, status: res.status };
    }
    return { ok: true };
  }

  /** Create a new visit on an existing inspection, then stamp its id back
   * onto the platform appointment row — mirrors ServiceTrade's create+stamp
   * pattern. Dispatched by the JOB's source (a freshly created platform
   * appointment has no CRM source of its own yet). */
  async mirrorCreateAppointment(companyId, appointment, platformJobId, { scheduledStart, retellCallId = null } = {}) {
    const { rows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [platformJobId, companyId]);
    const job = rows[0];
    if (!job || job.source !== SOURCE || !isNumericRef(job.external_ref)) return { skipped: "not_inspectpoint" };

    const res = await this.request(companyId, "POST", "/external/api/v1/inspection_visits", {
      body: { visit: { inspection_id: Number(job.external_ref), scheduled_date: scheduledStart } },
    });
    const newId = res.data?.visit?.id;
    if (!res.ok || !newId) {
      await raiseCrmSyncTodo(companyId, { action: "create_appointment", entity: "inspection", entityId: job.external_ref, error: JSON.stringify(res.messages || res.status) });
      return { ok: false, status: res.status };
    }
    await db.query(
      `UPDATE appointments SET external_ref = $1, source = $2, updated_at = NOW() WHERE id = $3 AND company_id = $4`,
      [String(newId), SOURCE, appointment.id, companyId]
    );
    return { ok: true, inspectPointVisitId: String(newId) };
  }

  // ── CRM comment write-back ───────────────────────────────────────────────
  //
  // InspectPoint has no comments API at all — "append" means GET the
  // inspection, concatenate a marker-prefixed line onto internal_notes, PATCH
  // it back. That read-modify-write can lose a concurrent write from the
  // OTHER channel (a voice call and a chat session touching the same
  // inspection close together), so it's serialized with a Postgres advisory
  // lock held for the duration of both HTTP calls — the lock protects an
  // external critical section, not any database row, which is a legitimate
  // use of pg_advisory_xact_lock as a cross-process mutex.

  async _appendInternalNote(companyId, inspectionExternalRef, noteText) {
    if (!isNumericRef(inspectionExternalRef)) return { skipped: "no_inspection_ref" };
    return db.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`inspectpoint_note:${companyId}:${inspectionExternalRef}`]);
      const getRes = await this.request(companyId, "GET", `/external/api/v1/inspections/${encodeURIComponent(inspectionExternalRef)}`);
      if (!getRes.ok) {
        await raiseCrmSyncTodo(companyId, { action: "post_comment", entity: "inspection", entityId: inspectionExternalRef, error: "failed to read internal_notes before append" });
        return { ok: false, status: getRes.status };
      }
      const existing = getRes.data?.inspection?.internal_notes || "";
      const updated = existing ? `${existing}\n${noteText}` : noteText;
      const patchRes = await this.request(companyId, "PATCH", `/external/api/v1/inspections/${encodeURIComponent(inspectionExternalRef)}`, {
        body: { inspection: { internal_notes: updated } },
      });
      if (!patchRes.ok) {
        await raiseCrmSyncTodo(companyId, { action: "post_comment", entity: "inspection", entityId: inspectionExternalRef, error: JSON.stringify(patchRes.messages || patchRes.status) });
        return { ok: false, status: patchRes.status };
      }
      return { ok: true };
    });
  }

  async _resolveInspectionRef(companyId, jobId) {
    if (!jobId) return null;
    const { rows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [jobId, companyId]);
    return rows[0]?.source === SOURCE ? rows[0].external_ref : null;
  }

  /** Chat outcome — companyId, {jobId, threadId, summaryLines, recipientName, expired}. */
  async mirrorPostChatComment(companyId, { jobId, summaryLines, recipientName = null, expired = false } = {}) {
    if (!summaryLines || summaryLines.length === 0) return { skipped: "nothing_reportable" };
    const ref = await this._resolveInspectionRef(companyId, jobId);
    if (!ref) return { skipped: "not_inspectpoint" };
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const lapsedNote = expired ? " The chat then lapsed without a formal close." : "";
    const note = `[Clara ${timestamp}] Chat outcome: ${summaryLines.join(" ")}${lapsedNote} Who confirmed: ${recipientName || "unknown"}.`;
    return this._appendInternalNote(companyId, ref, note);
  }

  /** Call outcome — companyId, {scheduledCall, callSummary}. */
  async mirrorPostCallComment(companyId, { scheduledCall, callSummary = null } = {}) {
    const ref = await this._resolveInspectionRef(companyId, scheduledCall?.job_id);
    if (!ref) return { skipped: "not_inspectpoint" };
    const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const note = `[Clara ${timestamp}] Call outcome: ${callSummary || "see call recording"}.`;
    return this._appendInternalNote(companyId, ref, note);
  }

  /**
   * Pull from InspectPoint, populate raw tables, then normalize into platform
   * tables. Same shape as ServiceTradeProvider.syncAll — `engine` optional,
   * `full` forces a full re-pull. `scheduleDateFrom`/`scheduleDateTo` (unix
   * seconds — the same names/units engines/crm-sync passes to every provider
   * uniformly) request a custom inspections/visits window instead of the
   * default rolling one; see inspectpoint-sync.js's runSync for what that
   * changes.
   */
  async syncAll(companyId, { full = false, engine = null, scheduleDateFrom = null, scheduleDateTo = null } = {}) {
    try {
      const rawResult = await ipSync.runSync(companyId, { full, engine, scheduleDateFrom, scheduleDateTo });
      if (!rawResult.success) {
        return { ok: false, counts: rawResult.counts || {}, error: rawResult.error };
      }

      if (engine) await engine.transition("normalizing", {});
      logger.info("InspectPointProvider: normalizing raw data into platform tables", { companyId, rawCounts: rawResult.counts });
      const normResult = await this.normalizeAll(companyId, engine);

      const counts = { ...rawResult.counts, normalized: normResult };
      const incomplete = rawResult.incomplete || [];
      if (incomplete.length) {
        logger.warn("InspectPointProvider.syncAll: partial run, will retry these entities next tick", { companyId, incomplete, counts });
      } else {
        logger.info("InspectPointProvider.syncAll done", { companyId, counts });
      }
      return { ok: true, counts, incomplete };
    } catch (err) {
      logger.error("InspectPointProvider.syncAll failed", { companyId, error: err.message });
      return { ok: false, error: err.message };
    }
  }

  /**
   * Order matters: customers before contacts/locations (both need
   * customerId); contacts before locations (locations need the derived
   * primary contact's PLATFORM id, which only exists once contacts are
   * upserted); technicians before jobs/appointments; locations before jobs;
   * jobs before appointments.
   */
  async normalizeAll(companyId, engine = null) {
    const counts = { customers: 0, contacts: 0, technicians: 0, locations: 0, jobs: 0, appointments: 0 };
    const emit = (entity, count) => engine && engine.emit("entity_done", { entity, count });

    counts.customers = await this._normalizeCustomers(companyId);
    emit("customers", counts.customers);

    const rawContacts = await db.fetchAllByCompanyChunked(companyId, "inspectpoint_contacts");
    const primaryByBuilding = buildPrimaryContactByBuilding(rawContacts);

    counts.contacts = await this._normalizeContacts(companyId, rawContacts, primaryByBuilding);
    emit("contacts", counts.contacts);
    counts.technicians = await this._normalizeTechnicians(companyId);
    emit("technicians", counts.technicians);
    counts.locations = await this._normalizeLocations(companyId, primaryByBuilding);
    emit("locations", counts.locations);
    await this._normalizeContactJunctions(companyId, rawContacts);
    // inspectpoint_jobs is by far the heaviest raw table (thousands of rows,
    // multi-kB payload each), and THREE passes below need it. Fetched once and
    // shared — same reason rawContacts is hoisted above. Re-reading it per
    // pass tripled the largest read in the pipeline and blew past
    // query_timeout on a slow pooled link, which is exactly the failure
    // fetchAllByCompanyChunked's chunking exists to avoid.
    const rawJobs = await db.fetchAllByCompanyChunked(companyId, "inspectpoint_jobs");

    // Service lines are derived from the inspections themselves (InspectPoint
    // has no service-line endpoint), so they must land before appointment
    // services can reference them — but they don't depend on jobs, so the
    // order relative to _normalizeJobs is free.
    counts.serviceLines = await this._normalizeServiceLines(companyId, rawJobs);
    emit("service_lines", counts.serviceLines);
    counts.jobs = await this._normalizeJobs(companyId, rawJobs);
    emit("jobs", counts.jobs);
    counts.appointments = await this._normalizeAppointments(companyId);
    emit("appointments", counts.appointments);
    // Strictly last: needs appointment ids, job ids AND service line ids.
    counts.appointmentServices = await this._normalizeAppointmentServices(companyId, rawJobs);
    emit("appointment_services", counts.appointmentServices);

    return counts;
  }

  async _normalizeCustomers(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "inspectpoint_customers");
    const argsList = raw.map((row) => normalize.normalizeCustomer(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("customers", CUSTOMER_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeContacts(companyId, rawContacts, primaryByBuilding) {
    const primaryContactIds = new Set(primaryByBuilding.values());
    const argsList = rawContacts
      .map((row) => normalize.normalizeContact(row, { companyId, isPrimary: primaryContactIds.has(String(row.inspectpoint_id)) }))
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("contacts", CONTACT_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeTechnicians(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "inspectpoint_technicians");
    // InspectPoint service accounts, not people — they can never receive a
    // confirmation and would pollute technician pickers.
    const people = raw.filter((row) => !(row.payload || {}).system);
    const skipped = raw.length - people.length;
    if (skipped > 0) logger.info("InspectPointProvider: skipped system technician rows", { companyId, skipped });
    const argsList = people.map((row) => normalize.normalizeTechnician(row, { companyId })).filter(Boolean);
    await db.bulkUpsertByExternalRef("technicians", TECHNICIAN_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeLocations(companyId, primaryByBuilding) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "inspectpoint_locations");
    const [customersMap, contactsMap] = await Promise.all([
      refMap(companyId, "customers"),
      refMap(companyId, "contacts"),
    ]);
    const argsList = raw
      .map((row) => {
        const customerId = row.inspectpoint_customer_id != null ? customersMap.get(String(row.inspectpoint_customer_id)) ?? null : null;
        const primaryExternalRef = primaryByBuilding.get(String(row.inspectpoint_id));
        const primaryContactId = primaryExternalRef != null ? contactsMap.get(primaryExternalRef) ?? null : null;
        return normalize.normalizeLocation(row, { companyId, customerId, primaryContactId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("locations", LOCATION_FIELDS, argsList);
    return argsList.length;
  }

  /**
   * contact_locations / contact_companies — many-to-many, both already exist
   * (migration 054). Use replaceJunction (not a plain insert) so a link
   * removed on InspectPoint's side (a contact unassigned from a building)
   * actually disappears here too — see shared/junctions.js's doc comment for
   * the bug this prevents.
   */
  async _normalizeContactJunctions(companyId, rawContacts) {
    const [contactsMap, locationsMap, customersMap] = await Promise.all([
      refMap(companyId, "contacts"),
      refMap(companyId, "locations"),
      refMap(companyId, "customers"),
    ]);
    const locationPairs = [];
    const companyPairs = [];
    const contactParents = [];
    for (const row of rawContacts) {
      const contactId = contactsMap.get(String(row.inspectpoint_id));
      if (contactId == null) continue;
      contactParents.push(contactId);
      const p = row.payload || {};
      for (const b of Array.isArray(p.buildings) ? p.buildings : []) {
        const locationId = b?.id != null ? locationsMap.get(String(b.id)) : null;
        if (locationId != null) locationPairs.push([contactId, locationId]);
      }
      if (row.inspectpoint_customer_id != null) {
        const customerId = customersMap.get(String(row.inspectpoint_customer_id));
        if (customerId != null) companyPairs.push([contactId, customerId]);
      }
    }
    await replaceJunction("contact_locations", "contact_id", "location_id", locationPairs, contactParents);
    await replaceJunction("contact_companies", "contact_id", "customer_id", companyPairs, contactParents);
  }

  async _normalizeJobs(companyId, raw) {
    const [customersMap, locationsMap, techniciansMap] = await Promise.all([
      refMap(companyId, "customers"),
      refMap(companyId, "locations"),
      refMap(companyId, "technicians"),
    ]);
    // primary_contact_id on the job mirrors the building's own primary
    // contact — read straight off the already-normalized locations row
    // rather than re-deriving it, so the two never disagree.
    const { rows: locationRows } = await db.query(
      `SELECT id, primary_contact_id FROM locations WHERE company_id = $1 AND source = $2`,
      [companyId, SOURCE]
    );
    const primaryContactByLocationId = new Map(locationRows.map((r) => [r.id, r.primary_contact_id]));

    const argsList = raw
      .map((row) => {
        const customerId = row.inspectpoint_customer_id != null ? customersMap.get(String(row.inspectpoint_customer_id)) ?? null : null;
        const locationId = row.inspectpoint_location_id != null ? locationsMap.get(String(row.inspectpoint_location_id)) ?? null : null;
        const technicianId = row.inspectpoint_technician_id != null ? techniciansMap.get(String(row.inspectpoint_technician_id)) ?? null : null;
        const primaryContactId = locationId != null ? primaryContactByLocationId.get(locationId) ?? null : null;
        const jobTypeName = (row.payload || {}).resolved_type_name || null;
        return normalize.normalizeJob(row, { companyId, customerId, locationId, technicianId, primaryContactId, jobTypeName });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("jobs", JOB_FIELDS, argsList);
    return argsList.length;
  }

  async _normalizeAppointments(companyId) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "inspectpoint_appointments");
    const [jobsMap, techniciansMap] = await Promise.all([
      refMap(companyId, "jobs"),
      refMap(companyId, "technicians"),
    ]);
    const argsList = raw
      .map((row) => {
        const jobId = row.inspectpoint_job_id != null ? jobsMap.get(String(row.inspectpoint_job_id)) ?? null : null;
        const technicianId = row.inspectpoint_technician_id != null ? techniciansMap.get(String(row.inspectpoint_technician_id)) ?? null : null;
        return normalize.normalizeAppointment(row, { companyId, jobId, technicianId });
      })
      .filter(Boolean);
    await db.bulkUpsertByExternalRef("appointments", APPOINTMENT_FIELDS, argsList);
    return argsList.length;
  }

  /**
   * Distinct inspection types (and named custom inspections) across this
   * company's inspections -> `service_lines`. There is no service-line
   * endpoint in InspectPoint, so the catalogue is derived from the work
   * itself; deduped by the same external_ref the appointment-service join
   * resolves against.
   */
  async _normalizeServiceLines(companyId, raw) {
    const byRef = new Map();
    for (const row of raw) {
      const line = normalize.normalizeServiceLine(row.payload || {}, { companyId });
      if (line) byRef.set(line.externalRef, line);
    }
    const argsList = [...byRef.values()];
    await db.bulkUpsertByExternalRef("service_lines", SERVICE_LINE_FIELDS, argsList);
    return argsList.length;
  }

  /**
   * One appointment_services row per visit, carrying the composed description
   * and (where one could be derived) the service line. This is what makes
   * job-confirmation-context's `service_details` non-empty for InspectPoint —
   * without it the agent has no way to say what a visit actually covers.
   */
  async _normalizeAppointmentServices(companyId, rawJobs) {
    const raw = await db.fetchAllByCompanyChunked(companyId, "inspectpoint_appointments");
    const jobPayloadByRef = new Map(rawJobs.map((j) => [String(j.inspectpoint_id), j.payload || {}]));

    const [appointmentsMap, jobsMap, serviceLinesMap] = await Promise.all([
      refMap(companyId, "appointments"),
      refMap(companyId, "jobs"),
      refMap(companyId, "service_lines"),
    ]);

    const argsList = raw
      .map((row) => {
        const appointmentId = appointmentsMap.get(String(row.inspectpoint_id)) ?? null;
        if (!appointmentId) return null;
        const jobRef = row.inspectpoint_job_id != null ? String(row.inspectpoint_job_id) : null;
        const jobPayload = jobRef ? jobPayloadByRef.get(jobRef) || {} : {};
        const serviceLineRef = normalize.deriveServiceLineRef(jobPayload);
        return normalize.normalizeAppointmentService(row, {
          companyId,
          appointmentId,
          jobId: jobRef ? jobsMap.get(jobRef) ?? null : null,
          serviceLineId: serviceLineRef ? serviceLinesMap.get(serviceLineRef) ?? null : null,
          jobPayload,
        });
      })
      .filter(Boolean);

    await db.bulkUpsertByExternalRef("appointment_services", APPOINTMENT_SERVICE_FIELDS, argsList);
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
  // The visit's own schedule. Omitting these was a real bug: normalizeAppointment
  // produced scheduledStart/scheduledEnd all along, but with no field descriptor
  // to write them every synced appointment landed with scheduled_start = NULL —
  // which is the one column the confirmation agent, the scheduler sweep and
  // technician-availability all read. Plain overwrite, same as ServiceTrade's
  // equivalent: the CRM owns the schedule; a local reschedule reaches the CRM
  // through the write-back mirror and comes back through this column.
  { column: "scheduled_start", key: "scheduledStart" },
  { column: "scheduled_end", key: "scheduledEnd" },
  {
    column: "status",
    key: "status",
    transform: (v) => v || "scheduled",
    // InspectPoint has no 'confirmed' state of its own. A plain overwrite
    // here would reset every appointment our agent confirmed back to
    // 'scheduled' on the very next sync, silently undoing real confirmations
    // made by either channel. ServiceTrade doesn't need this guard because it
    // has a real 'confirmed' status that round-trips through write-back.
    updateExpr: `status = CASE WHEN appointments.status IN ('confirmed','rescheduled','cancelled') THEN appointments.status ELSE EXCLUDED.status END`,
  },
  { column: "duration", key: "duration" },
];

const SERVICE_LINE_FIELDS = [
  { column: "name", key: "name" },
  { column: "trade", key: "trade" },
  { column: "abbr", key: "abbr" },
  { column: "icon", key: "icon" },
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

module.exports = new InspectPointProvider();
// Exposed for direct unit testing of the upsert field descriptors (notably
// APPOINTMENT_FIELDS' confirmation-status-preserving updateExpr) against the
// real db.bulkUpsertByExternalRef — not part of the CrmProvider interface.
module.exports.FIELDS = { CUSTOMER_FIELDS, LOCATION_FIELDS, CONTACT_FIELDS, TECHNICIAN_FIELDS, JOB_FIELDS, APPOINTMENT_FIELDS, SERVICE_LINE_FIELDS, APPOINTMENT_SERVICE_FIELDS };
