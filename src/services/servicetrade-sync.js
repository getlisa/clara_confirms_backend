/**
 * ServiceTrade sync engine — simplified.
 *
 * Pulls entities and writes them to the matching raw tables:
 *   GET /company                                        → servicetrade_customers
 *   GET /job                                            → servicetrade_jobs (+ inline appointments → servicetrade_appointments)
 *   GET /user?isTech=true                               → servicetrade_technicians
 *   GET /location?isCustomer=true&status=active&companyStatus=active
 *                                                        → servicetrade_locations
 *       (+ embedded primaryContact → servicetrade_contacts,
 *          embedded offices[]      → servicetrade_offices,
 *          embedded tags[]         → servicetrade_tags —
 *          all fanned out from the same /location response, no separate API calls)
 *   GET /servicerequest?windowStartBefore=...&windowEndAfter=...&available=true&excludeUnapproved=true
 *                                                        → servicetrade_service_requests
 *       (+ embedded serviceLine/deficiency/changeOrder/contract/serviceRecurrence
 *          each fanned into their own table; embedded job/location stub-inserted
 *          into jobs/locations ONLY if missing — never overwritten, since the
 *          dedicated /job and /location syncs are authoritative for those rows;
 *          embedded preferredTechs[] resolved against technicians during normalize)
 *
 * Pagination is handled via ServiceTrade's `page`/`totalPages` response shape.
 * 429 / 5xx responses are retried with exponential backoff. Per-entity cursors
 * are tracked in `servicetrade_sync_state` so subsequent runs are incremental.
 */
const stClient      = require("./servicetrade");
const credentialsDb = require("../db/servicetrade-credentials");
const syncDb        = require("../db/servicetrade-sync");
const logger        = require("../utils/logger");

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS  = 2000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── HTTP with retry ─────────────────────────────────────────────────────────

async function requestWithRetry(companyId, method, path, opts = {}, credentials = null) {
  let last = null;
  for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await stClient.request(companyId, method, path, opts, credentials);
    } catch (err) {
      // Network-level failure (DNS, connection refused, timeout) — stClient.request()
      // throws in this case rather than returning {ok:false}. Retry it exactly like
      // a 429/5xx instead of letting it crash the whole sync run.
      last = { ok: false, status: 0, data: null, messages: { error: [err.message] } };
      const wait = RETRY_BASE_MS * Math.pow(2, attempt);
      logger.warn("ServiceTrade network error, retrying", { companyId, path, error: err.message, attempt: attempt + 1, waitMs: wait });
      await sleep(wait);
      continue;
    }
    if (res.ok) return res;
    last = res;
    if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
      const wait = RETRY_BASE_MS * Math.pow(2, attempt);
      logger.warn("ServiceTrade retry", { companyId, path, status: res.status, attempt: attempt + 1, waitMs: wait });
      await sleep(wait);
      continue;
    }
    return res; // non-retryable
  }
  return last || { ok: false, status: 0, data: null, messages: {} };
}

/**
 * Page through a list endpoint, returning all rows under `listKey`.
 *
 * Returns `{ rows, complete }` — `complete` is false when pagination broke
 * off early due to a request that failed even after retries (network outage
 * outlasting the backoff window, or a non-retryable HTTP error). Callers
 * MUST NOT advance that entity's sync cursor when `complete` is false —
 * otherwise the pages that were never fetched are silently skipped forever
 * instead of being re-covered by the next incremental run.
 */
async function fetchAllPages(companyId, pathPrefix, listKey, credentials, params = {}) {
  const all = [];
  let page = 1;
  let complete = true;
  // ServiceTrade caps page size around 200; using 100 is safe and small enough to retry cheaply.
  const PER_PAGE = 100;
  while (true) {
    const qs = new URLSearchParams({ ...params, page: String(page), perPage: String(PER_PAGE) }).toString();
    const path = `${pathPrefix}?${qs}`;
    const res = await requestWithRetry(companyId, "GET", path, {}, credentials);
    if (!res.ok) {
      logger.warn("ServiceTrade fetch failed — entity fetch incomplete, cursor will not advance", { companyId, path, status: res.status });
      complete = false;
      break;
    }
    const list = Array.isArray(res.data?.[listKey]) ? res.data[listKey]
              : Array.isArray(res.data)            ? res.data
              : [];
    all.push(...list);
    const totalPages = Number(res.data?.totalPages) || 1;
    if (page >= totalPages || list.length === 0) break;
    page++;
  }
  return { rows: all, complete };
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once. Used for
 * per-id detail fetches (e.g. GET /appointment/{id}) where there's no bulk
 * list endpoint — bounds concurrent requests instead of firing them all at
 * once or running them one at a time.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ── Entity mappers (raw API row → DB row) ───────────────────────────────────

function mapCustomerRow(c) {
  return {
    servicetrade_id: Number(c.id),
    full_name:       c.name ?? null,
    email:           c.primaryEmail ?? c.email ?? null,
    phone:           c.phoneNumber ?? c.phone ?? null,
    address_line1:   c.address?.street ?? null,
    city:            c.address?.city ?? null,
    state:           c.address?.state ?? null,
    zipcode:         c.address?.postalCode ?? null,
    country:         c.address?.country ?? "US",
    is_active:       c.status ? c.status === "active" : c.active !== false,
    payload:         c,
  };
}

function mapJobRow(j) {
  // ServiceTrade jobs include `companyId` (the ST company id of the customer)
  // and may have a `location.companyId` fallback.
  const customerId = j.customer?.id ?? j.companyId ?? j.company?.id ?? j.location?.companyId ?? null;
  const windowStart = j.windowStart ? new Date(j.windowStart * 1000) : null;
  const windowEnd   = j.windowEnd   ? new Date(j.windowEnd   * 1000) : null;
  return {
    servicetrade_id:           Number(j.id),
    servicetrade_customer_id:  customerId != null ? Number(customerId) : null,
    title:                     j.name ?? j.description?.slice(0, 200) ?? null,
    description:               j.description ?? null,
    job_type:                  j.type ?? j.serviceLine?.name ?? null,
    status:                    j.status ?? null,
    scheduled_date:            windowStart ? windowStart.toISOString().slice(0, 10) : null,
    scheduled_window_start:    windowStart ? windowStart.toISOString() : null,
    scheduled_window_end:      windowEnd   ? windowEnd.toISOString() : null,
    is_active:                 j.status ? j.status !== "canceled" && j.status !== "cancelled" : true,
    payload:                   j,
  };
}

function mapAppointmentRow(a, jobId) {
  return {
    servicetrade_id:             Number(a.id),
    servicetrade_job_id:         jobId,
    servicetrade_technician_id:  a.techs?.[0]?.id ?? a.technicianId ?? a.tech?.id ?? null,
    status:                      a.status ?? null,
    scheduled_start:             a.windowStart ? new Date(a.windowStart * 1000).toISOString() : null,
    scheduled_end:               a.windowEnd   ? new Date(a.windowEnd   * 1000).toISOString() : null,
    payload:                     a,
  };
}

function mapTechnicianRow(u) {
  return {
    servicetrade_id: Number(u.id),
    first_name:      u.firstName ?? null,
    last_name:       u.lastName  ?? null,
    email:           u.email ?? null,
    phone:           u.phone ?? u.phoneNumber ?? u.cellPhone ?? null,
    is_active:       u.status ? u.status === "active" : u.active !== false,
    payload:         u,
  };
}

function mapLocationRow(l) {
  const customerId = l.company?.id ?? null;
  const contactId  = l.primaryContact?.id ?? null;
  return {
    servicetrade_id:                 Number(l.id),
    servicetrade_customer_id:        customerId != null ? Number(customerId) : null,
    servicetrade_primary_contact_id: contactId  != null ? Number(contactId)  : null,
    name:                            l.name ?? null,
    lat:                             l.lat ?? null,
    lon:                             l.lon ?? null,
    phone:                           l.phoneNumber ?? null,
    email:                           l.email ?? null,
    // generalManager is a plain display-name string in ServiceTrade, not a contact object.
    general_manager_name:           typeof l.generalManager === "string" ? l.generalManager : (l.generalManager?.name ?? null),
    address_line1:                  l.address?.street ?? null,
    city:                            l.address?.city ?? null,
    state:                           l.address?.state ?? null,
    zipcode:                        l.address?.postalCode ?? null,
    country:                        l.address?.country ?? "US",
    taxable:                        l.taxable ?? null,
    company:                        l.company ?? null,
    brand:                          l.brand ?? null,
    status:                         l.status ?? null,
    is_active:                     l.status ? l.status === "active" : l.active !== false,
    payload:                       l,
  };
}

function mapContactRow(c) {
  return {
    servicetrade_id: Number(c.id),
    first_name:      c.firstName ?? null,
    last_name:       c.lastName ?? null,
    phone:           c.phone ?? null,
    mobile:          c.mobile ?? null,
    alternate_phone: c.alternatePhone ?? null,
    email:           c.email ?? null,
    type:            c.type ?? null,
    // Only present on the full /contact response, not location.primaryContact's
    // smaller embed — captured defensively so nothing breaks once a real
    // /contact sync is added later.
    status:          c.status ?? null,
    types:           Array.isArray(c.types) ? c.types : null,
    external_ids:    c.externalIds ?? null,
    payload:         c,
  };
}

function mapOfficeRow(o) {
  return {
    servicetrade_id: Number(o.id),
    name:            o.name ?? null,
    address_line1:   o.address?.street ?? null,
    city:            o.address?.city ?? null,
    state:           o.address?.state ?? null,
    zipcode:         o.address?.postalCode ?? null,
    country:         o.address?.country ?? "US",
    lat:             o.lat ?? null,
    lon:             o.lon ?? null,
    phone:           o.phoneNumber ?? null,
    email:           o.email ?? null,
    status:          o.status ?? null,
    is_active:       o.status ? o.status === "active" : o.active !== false,
    payload:         o,
  };
}

function mapTagRow(t) {
  return {
    servicetrade_id: Number(t.id),
    name:            t.name ?? null,
    payload:         t,
  };
}

function mapServiceLineRow(sl) {
  return { servicetrade_id: Number(sl.id), name: sl.name ?? null, trade: sl.trade ?? null, abbr: sl.abbr ?? null, icon: sl.icon ?? null, payload: sl };
}

function mapDeficiencyRow(d) {
  return { servicetrade_id: Number(d.id), ref_number: d.refNumber ?? null, name: d.name ?? null, description: d.description ?? null, payload: d };
}

function mapChangeOrderRow(co) {
  return { servicetrade_id: Number(co.id), status: co.status ?? null, type: co.type ?? null, reference_number: co.referenceNumber ?? null, payload: co };
}

function mapContractRow(c) {
  return { servicetrade_id: Number(c.id), name: c.name ?? null, payload: c };
}

function mapServiceRecurrenceRow(sr) {
  return {
    servicetrade_id:     Number(sr.id),
    description:         sr.description ?? null,
    frequency:           sr.frequency ?? null,
    recurrence_interval: sr.interval ?? null,
    repeat_weekday:      sr.repeatWeekday ?? null,
    payload:             sr,
  };
}

/** Minimal job stub, only used to guarantee FK-resolvability — never overwrites an existing row. */
function mapJobStubRow(j) {
  return {
    servicetrade_id: Number(j.id),
    title:           j.name ?? j.customName ?? (j.number ? `Job ${j.number}` : null),
    job_type:        j.type ?? null,
    payload:         j,
  };
}

/** Minimal location stub (service-request's embedded location lacks company/offices/tags/brand) — insert-only. */
function mapLocationStubRow(l) {
  return {
    servicetrade_id: Number(l.id),
    name:            l.name ?? null,
    lat:             l.lat ?? null,
    lon:             l.lon ?? null,
    phone:           l.phoneNumber ?? null,
    email:           l.email ?? null,
    general_manager_name: typeof l.generalManager === "string" ? l.generalManager : (l.generalManager?.name ?? null),
    address_line1:   l.address?.street ?? null,
    city:            l.address?.city ?? null,
    state:           l.address?.state ?? null,
    zipcode:         l.address?.postalCode ?? null,
    country:         l.address?.country ?? "US",
    taxable:         l.taxable ?? null,
    status:          l.status ?? null,
    is_active:       l.status ? l.status === "active" : l.active !== false,
    payload:         l,
  };
}

/**
 * `opts.appointmentId`/`opts.jobId` are set when this row comes from an
 * appointment DETAIL fetch (GET /appointment/{id}) rather than the /servicerequest
 * list — those nested serviceRequests[] entries have no `job` field of their own,
 * so the parent appointment's job id is passed in explicitly. An options OBJECT
 * (not a positional param) is used deliberately: the existing
 * `serviceRequests.map(mapServiceRequestRow)` call site implicitly passes
 * (row, index, array) — destructuring a number as `{appointmentId} = index`
 * safely yields `undefined`, so that call site stays correct without change.
 */
function mapServiceRequestRow(r, { appointmentId = null, jobId = null } = {}) {
  const toIso = (unixSeconds) => (unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null);
  return {
    servicetrade_id:               Number(r.id),
    status:                        r.status ?? null,
    completion:                    r.completion ?? null,
    description:                   r.description ?? null,
    servicetrade_service_line_id:  r.serviceLine?.id ?? null,
    servicetrade_job_id:           r.job?.id ?? jobId ?? null,
    servicetrade_appointment_id:   appointmentId,
    servicetrade_deficiency_id:    r.deficiency?.id ?? null,
    servicetrade_change_order_id:  r.changeOrder?.id ?? null,
    servicetrade_contract_id:      r.contract?.id ?? null,
    servicetrade_location_id:      r.location?.id ?? null,
    servicetrade_recurrence_id:    r.serviceRecurrence?.id ?? null,
    asset:                         r.asset ?? null,
    budget:                        r.budget ?? null,
    window_start:                  toIso(r.windowStart),
    window_end:                    toIso(r.windowEnd),
    closed_on:                     toIso(r.closedOn),
    estimated_price:               r.estimatedPrice ?? null,
    duration:                      r.duration ?? null,
    preferred_start_time:          r.preferredStartTime ?? null,
    preferred_vendor:              r.preferredVendor ?? null,
    visibility:                    r.visibility ?? null,
    payload:                       r,
  };
}

/**
 * Build /servicerequest query params. `available`/`excludeUnapproved` are
 * always sent; the window params scope the fetch to a horizon (default
 * month) — omitted entirely when `full` is true. locationName/officeIds are
 * intentionally NOT sent — ServiceTrade returns account-wide results without
 * them, and location/office filtering happens at our own platform API layer.
 */
function buildServiceRequestParams({ range = "month", full = false } = {}) {
  const params = { available: "true", excludeUnapproved: "true" };
  if (full) return params;
  const days = { week: 7, month: 30, "3month": 90 }[range] || 30;
  const now = Math.floor(Date.now() / 1000);
  params.windowStartBefore = String(now + days * 86400);
  params.windowEndAfter    = String(now - 5 * 60); // small buffer, avoid clock-skew gaps
  return params;
}

// ── Main sync ───────────────────────────────────────────────────────────────

/**
 * Run a full or incremental sync for a company. Returns counts per entity.
 *
 * @param {number|string} companyId
 * @param {object} [options]
 * @param {boolean} [options.full=false] — when true, ignore cursors and re-pull everything
 */
async function runSync(companyId, options = {}) {
  const full = !!options.full;
  const range = options.range || "month";
  const engine = options.engine || null;
  const credentials = await credentialsDb.getByCompanyId(companyId);
  if (!credentials) return { success: false, error: "ServiceTrade not connected" };

  const state = await syncDb.getSyncState(companyId);
  const counts = {
    customers: 0, jobs: 0, appointments: 0, technicians: 0, locations: 0, contacts: 0, offices: 0, tags: 0,
    serviceRequests: 0, serviceLines: 0, deficiencies: 0, changeOrders: 0, contracts: 0, serviceRecurrences: 0,
    appointmentServiceLines: 0, appointmentServiceRequests: 0,
  };
  // Tracks which entities' fetches ran to completion this pass — an entity's
  // cursor only advances if its own fetch was complete (see fetchAllPages doc).
  const complete = { customers: true, locations: true, technicians: true, jobs: true, serviceRequests: true };

  logger.info("ServiceTrade sync starting", { companyId, mode: full ? "full" : "incremental", range });

  try {
    // --- Customers (/company) ----------------------------------------------
    if (engine) await engine.transition("fetching_customers", { full });
    logger.info("ServiceTrade sync: fetching customers", { companyId });
    const { rows: customers, complete: customersComplete } = await fetchAllPages(companyId, "/company", "companies", credentials,
      full ? {} : cursorParams(state?.last_customers_updated_at));
    complete.customers = customersComplete;
    if (customers.length) {
      await syncDb.upsertCustomersBatch(companyId, customers.map(mapCustomerRow));
      counts.customers = customers.length;
    }
    logger.info("ServiceTrade sync: wrote customers", { companyId, table: "servicetrade_customers", count: counts.customers, complete: customersComplete });
    if (engine) await engine.emit("fetched", { entity: "customers", count: counts.customers });

    // --- Locations + embedded contact/offices/tags (/location) -------------
    if (engine) await engine.transition("fetching_locations", { full });
    logger.info("ServiceTrade sync: fetching locations", { companyId });
    const { rows: locations, complete: locationsComplete } = await fetchAllPages(companyId, "/location", "locations", credentials, {
      isCustomer: "true", status: "active", companyStatus: "active",
      ...(full ? {} : cursorParams(state?.last_locations_updated_at)),
    });
    complete.locations = locationsComplete;
    if (locations.length) {
      await syncDb.upsertLocationsBatch(companyId, locations.map(mapLocationRow));
      counts.locations = locations.length;

      // Fan out embedded sub-objects, deduped by servicetrade_id — no separate
      // /contact, /location (offices), or /tag bulk endpoint calls needed.
      const contactsById = new Map();
      const officesById  = new Map();
      const tagsById     = new Map();
      for (const l of locations) {
        if (l.primaryContact?.id != null) contactsById.set(l.primaryContact.id, l.primaryContact);
        for (const o of Array.isArray(l.offices) ? l.offices : []) {
          if (o && o.id != null) officesById.set(o.id, o);
        }
        for (const t of Array.isArray(l.tags) ? l.tags : []) {
          if (t && t.id != null) tagsById.set(t.id, t);
        }
      }
      if (contactsById.size) {
        await syncDb.upsertContactsBatch(companyId, Array.from(contactsById.values()).map(mapContactRow));
        counts.contacts = contactsById.size;
      }
      if (officesById.size) {
        await syncDb.upsertOfficesBatch(companyId, Array.from(officesById.values()).map(mapOfficeRow));
        counts.offices = officesById.size;
      }
      if (tagsById.size) {
        await syncDb.upsertTagsBatch(companyId, Array.from(tagsById.values()).map(mapTagRow));
        counts.tags = tagsById.size;
      }
    }
    logger.info("ServiceTrade sync: wrote locations", {
      companyId, table: "servicetrade_locations", count: counts.locations, complete: locationsComplete,
      fanOut: { contacts: counts.contacts, offices: counts.offices, tags: counts.tags },
    });
    if (engine) {
      await engine.emit("fetched", { entity: "locations", count: counts.locations });
      await engine.emit("fetched", { entity: "contacts", count: counts.contacts });
      await engine.emit("fetched", { entity: "offices", count: counts.offices });
      await engine.emit("fetched", { entity: "tags", count: counts.tags });
    }

    // --- Technicians (/user?isTech=true) -----------------------------------
    if (engine) await engine.transition("fetching_technicians", {});
    logger.info("ServiceTrade sync: fetching technicians", { companyId });
    const { rows: techs, complete: techsComplete } = await fetchAllPages(companyId, "/user", "users", credentials, { isTech: "true" });
    complete.technicians = techsComplete;
    if (techs.length) {
      await syncDb.upsertTechniciansBatch(companyId, techs.map(mapTechnicianRow));
      counts.technicians = techs.length;
    }
    logger.info("ServiceTrade sync: wrote technicians", { companyId, table: "servicetrade_technicians", count: counts.technicians, complete: techsComplete });
    if (engine) await engine.emit("fetched", { entity: "technicians", count: counts.technicians });

    // --- Jobs + embedded appointments (/job) ------------------------------
    if (engine) await engine.transition("fetching_jobs", { full });
    logger.info("ServiceTrade sync: fetching jobs", { companyId });
    const { rows: jobs, complete: jobsComplete } = await fetchAllPages(companyId, "/job", "jobs", credentials,
      full ? {} : cursorParams(state?.last_jobs_updated_at));
    complete.jobs = jobsComplete;
    if (jobs.length) {
      await syncDb.upsertJobsBatch(companyId, jobs.map(mapJobRow));
      counts.jobs = jobs.length;

      // ServiceTrade jobs typically embed appointments[]. Flatten and upsert.
      const apptRows = [];
      for (const j of jobs) {
        const appts = Array.isArray(j.appointments) ? j.appointments : [];
        for (const a of appts) {
          if (a && a.id != null) apptRows.push(mapAppointmentRow(a, Number(j.id)));
        }
      }
      if (apptRows.length) {
        await syncDb.upsertAppointmentsBatch(companyId, apptRows);
        counts.appointments = apptRows.length;
      }
    }
    logger.info("ServiceTrade sync: wrote jobs", {
      companyId, table: "servicetrade_jobs", count: counts.jobs, complete: jobsComplete,
      appointments: counts.appointments,
    });
    if (engine) {
      await engine.emit("fetched", { entity: "jobs", count: counts.jobs });
      await engine.emit("fetched", { entity: "appointments", count: counts.appointments });
    }

    // --- Appointment details (/appointment/{id}) — service context ---------
    // The thin appointment stub embedded on /job has no service info. A
    // standalone GET /appointment/{id} (confirmed via a real captured request)
    // returns `serviceRequests[]` (each with a full serviceLine object) and a
    // `job` summary — exactly what's needed to tell the agent what service an
    // appointment/job is actually for, instead of just a bare job title/number.
    // No bulk/list endpoint is confirmed, so this fetches per-id with bounded
    // concurrency, and only for appointments in a near-term window (recent
    // past → ~45 days out) so a sync doesn't re-fetch full detail for the
    // entire historical appointment set every run.
    if (jobs.length) {
      const HORIZON_MS = 45 * 24 * 60 * 60 * 1000;
      const RECENT_MS  = 2  * 24 * 60 * 60 * 1000;
      const nowMs = Date.now();
      const apptIdsToDetail = [];
      for (const j of jobs) {
        for (const a of Array.isArray(j.appointments) ? j.appointments : []) {
          if (!a || a.id == null || !a.windowStart) continue;
          const t = a.windowStart * 1000;
          if (t >= nowMs - RECENT_MS && t <= nowMs + HORIZON_MS) apptIdsToDetail.push(Number(a.id));
        }
      }
      if (apptIdsToDetail.length) {
        if (engine) await engine.transition("fetching_appointment_details", { count: apptIdsToDetail.length });
        logger.info("ServiceTrade sync: fetching appointment details", { companyId, count: apptIdsToDetail.length });
        const detailResults = await mapWithConcurrency(apptIdsToDetail, 5, async (apptId) => {
          const res = await requestWithRetry(companyId, "GET", `/appointment/${apptId}`, {}, credentials);
          return res.ok ? res.data : null;
        });
        const fullDetails = detailResults.filter(Boolean);

        if (fullDetails.length) {
          // Re-upsert with the FULL detail payload (payload column now carries
          // serviceRequests[]/job/location/techs — no schema change needed there).
          const fullApptRows = fullDetails.map((a) =>
            mapAppointmentRow(a, a.job?.id != null ? Number(a.job.id) : null)
          );
          await syncDb.upsertAppointmentsBatch(companyId, fullApptRows);

          const apptServiceLinesById = new Map();
          const apptServiceRequestRows = [];
          for (const a of fullDetails) {
            const jobId = a.job?.id != null ? Number(a.job.id) : null;
            for (const r of Array.isArray(a.serviceRequests) ? a.serviceRequests : []) {
              if (r?.id == null) continue;
              if (r.serviceLine?.id != null) apptServiceLinesById.set(r.serviceLine.id, r.serviceLine);
              apptServiceRequestRows.push(mapServiceRequestRow(r, { appointmentId: Number(a.id), jobId }));
            }
          }
          if (apptServiceLinesById.size) {
            await syncDb.upsertServiceLinesBatch(companyId, Array.from(apptServiceLinesById.values()).map(mapServiceLineRow));
            counts.appointmentServiceLines = apptServiceLinesById.size;
          }
          if (apptServiceRequestRows.length) {
            await syncDb.upsertServiceRequestsBatch(companyId, apptServiceRequestRows);
            counts.appointmentServiceRequests = apptServiceRequestRows.length;
          }
        }
        logger.info("ServiceTrade sync: wrote appointment details", {
          companyId, fetched: fullDetails.length, requested: apptIdsToDetail.length,
          appointmentServiceLines: counts.appointmentServiceLines, appointmentServiceRequests: counts.appointmentServiceRequests,
        });
        if (engine) await engine.emit("fetched", { entity: "appointment_service_requests", count: counts.appointmentServiceRequests });
      }
    }

    // --- Service requests + embedded sub-objects (/servicerequest) ---------
    if (engine) await engine.transition("fetching_service_requests", { full });
    logger.info("ServiceTrade sync: fetching service requests", { companyId, range });
    const { rows: serviceRequests, complete: serviceRequestsComplete } = await fetchAllPages(companyId, "/servicerequest", "servicerequests", credentials,
      buildServiceRequestParams({ range: options.range, full }));
    complete.serviceRequests = serviceRequestsComplete;
    if (serviceRequests.length) {
      await syncDb.upsertServiceRequestsBatch(companyId, serviceRequests.map(mapServiceRequestRow));
      counts.serviceRequests = serviceRequests.length;

      const serviceLinesById = new Map();
      const deficienciesById = new Map();
      const changeOrdersById = new Map();
      const contractsById    = new Map();
      const recurrencesById  = new Map();
      const jobStubsById     = new Map();
      const locationStubsById = new Map();
      for (const r of serviceRequests) {
        if (r.serviceLine?.id != null) serviceLinesById.set(r.serviceLine.id, r.serviceLine);
        if (r.deficiency?.id != null) deficienciesById.set(r.deficiency.id, r.deficiency);
        if (r.changeOrder?.id != null) changeOrdersById.set(r.changeOrder.id, r.changeOrder);
        if (r.contract?.id != null) contractsById.set(r.contract.id, r.contract);
        if (r.serviceRecurrence?.id != null) recurrencesById.set(r.serviceRecurrence.id, r.serviceRecurrence);
        if (r.job?.id != null) jobStubsById.set(r.job.id, r.job);
        if (r.location?.id != null) locationStubsById.set(r.location.id, r.location);
      }
      if (serviceLinesById.size) {
        await syncDb.upsertServiceLinesBatch(companyId, Array.from(serviceLinesById.values()).map(mapServiceLineRow));
        counts.serviceLines = serviceLinesById.size;
      }
      if (deficienciesById.size) {
        await syncDb.upsertDeficienciesBatch(companyId, Array.from(deficienciesById.values()).map(mapDeficiencyRow));
        counts.deficiencies = deficienciesById.size;
      }
      if (changeOrdersById.size) {
        await syncDb.upsertChangeOrdersBatch(companyId, Array.from(changeOrdersById.values()).map(mapChangeOrderRow));
        counts.changeOrders = changeOrdersById.size;
      }
      if (contractsById.size) {
        await syncDb.upsertContractsBatch(companyId, Array.from(contractsById.values()).map(mapContractRow));
        counts.contracts = contractsById.size;
      }
      if (recurrencesById.size) {
        await syncDb.upsertServiceRecurrencesBatch(companyId, Array.from(recurrencesById.values()).map(mapServiceRecurrenceRow));
        counts.serviceRecurrences = recurrencesById.size;
      }
      // Insert-only stubs (never overwrite rows already synced via /job or /location).
      if (jobStubsById.size) {
        await syncDb.upsertJobStubsBatch(companyId, Array.from(jobStubsById.values()).map(mapJobStubRow));
      }
      if (locationStubsById.size) {
        await syncDb.upsertLocationStubsBatch(companyId, Array.from(locationStubsById.values()).map(mapLocationStubRow));
      }
    }
    logger.info("ServiceTrade sync: wrote service requests", {
      companyId, table: "servicetrade_service_requests", count: counts.serviceRequests, complete: serviceRequestsComplete,
      fanOut: {
        serviceLines: counts.serviceLines, deficiencies: counts.deficiencies, changeOrders: counts.changeOrders,
        contracts: counts.contracts, serviceRecurrences: counts.serviceRecurrences,
      },
    });
    if (engine) {
      await engine.emit("fetched", { entity: "serviceRequests", count: counts.serviceRequests });
    }

    // Bump cursors to "now" ONLY for entities whose fetch actually completed —
    // an incomplete entity keeps its old cursor so the next incremental run's
    // updatedAfter window re-covers whatever pages were missed this time,
    // instead of silently skipping them forever.
    const now = Math.floor(Date.now() / 1000);
    const incomplete = Object.entries(complete).filter(([, ok]) => !ok).map(([entity]) => entity);
    await syncDb.updateSyncState(companyId, {
      last_sync_at:                  now,
      last_full_sync_at:             full ? now : (state?.last_full_sync_at ?? null),
      last_sync_status:              incomplete.length ? "partial" : "success",
      last_sync_error:               incomplete.length ? `Incomplete entities (cursor not advanced): ${incomplete.join(", ")}` : null,
      last_customers_updated_at:     complete.customers     ? now : undefined,
      last_jobs_updated_at:          complete.jobs          ? now : undefined,
      last_appointments_updated_at:  complete.jobs          ? now : undefined, // appointments are embedded in the jobs fetch
      last_technicians_updated_at:   complete.technicians   ? now : undefined,
      last_locations_updated_at:     complete.locations     ? now : undefined,
      last_service_requests_updated_at: complete.serviceRequests ? now : undefined,
    });

    if (incomplete.length) {
      logger.warn("ServiceTrade sync partially incomplete — will retry these entities next run", { companyId, incomplete, counts });
    } else {
      logger.info("ServiceTrade sync done", { companyId, counts, mode: full ? "full" : "incremental" });
    }
    return { success: true, counts, incomplete };
  } catch (err) {
    logger.error("ServiceTrade sync error", { companyId, error: err.message });
    await syncDb.updateSyncState(companyId, {
      last_sync_status: "failed",
      last_sync_error:  (err.message || "ServiceTrade sync failed").slice(0, 1000),
    }).catch(() => {});
    return { success: false, error: err.message, counts };
  }
}

function cursorParams(lastUpdatedUnix) {
  if (!lastUpdatedUnix) return {};
  return { updatedAfter: String(lastUpdatedUnix - 5 * 60) }; // 5-minute overlap buffer
}

module.exports = {
  runSync,
  requestWithRetry,
  fetchAllPages,
  buildServiceRequestParams,
};
