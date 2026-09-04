/**
 * ServiceTrade sync engine — simplified.
 *
 * Pulls entities and writes them to the matching raw tables. Job-centric:
 * every entity below (locations/offices/tags/technicians) is derived from
 * job/appointment detail responses — there is no separate /location or
 * /user?isTech=true call. This is deliberate: a dedicated call for those
 * would be redundant with what /job/{id} and /appointment?jobId= already
 * carry, and /servicerequest can't be dropped the same way (see below).
 *
 * Customers and contacts are the exception: job.customer on /job/{id} is a
 * lightweight {id,name,status} stub — no phone, no address, no side-loaded
 * contacts[] (verified live against multiple real jobs/customers on this
 * account). A customer's own phone/address, and any contact who wasn't
 * specifically a job/location's primaryContact (a VP, a PM, someone who
 * never got that slot), are structurally invisible without two extra calls,
 * each made once per DISTINCT customer seen this run (not per job):
 * GET /company/{id} (full customer record) and GET /contact?companyId={id}
 * (full contact roster).
 *
 *   GET /job?status=scheduled&type=service_call,...&scheduleDateFrom=...&scheduleDateTo=...
 *                                                        → job ids only — scheduled, technician-site-visit job
 *                                                          types only (see TECHNICIAN_JOB_TYPES), scoped by default
 *                                                          to the current calendar month (custom window or
 *                                                          full-sync override available; see buildJobParams)
 *   GET /job/{id}          (per id, for new/updated jobs)→ servicetrade_jobs
 *       (+ customer          → servicetrade_customers, enriched by one
 *                               GET /company/{id} per distinct customer seen
 *                               this run (phone/address; job.customer alone
 *                               never carries them),
 *          location           → servicetrade_locations (customer borrowed from
 *                               the job — the flat shape omits location.company),
 *          primaryContact + location.primaryContact/contacts[] → servicetrade_contacts,
 *                               each stamped with the companies[]/locations[] it
 *                               was seen under, which is what populates the
 *                               contact_companies / contact_locations junctions,
 *          + one GET /contact?companyId={id} per distinct customer seen this
 *                               run → servicetrade_contacts — the customer's full
 *                               roster, which /job/{id} never carries; this
 *                               endpoint's contacts already come with real
 *                               companies[]/locations[], unlike the job-embedded ones,
 *          location.offices[]/assignedOffice/offices[] → servicetrade_offices,
 *          location.tags[]/tags[]             → servicetrade_tags,
 *          owner/sales        → servicetrade_users,
 *          project            → servicetrade_projects)
 *   GET /appointment?jobId={id} (per job)               → servicetrade_appointments
 *       (+ techs[]           → servicetrade_technicians — the only technician source now,
 *          offices[]         → servicetrade_offices,
 *          serviceRequests[] → servicetrade_service_requests + service_lines)
 *   GET /servicerequest?windowStartBefore=...&windowEndAfter=...&available=true&excludeUnapproved=true
 *                                                        → servicetrade_service_requests
 *       (kept: a service request with no job is structurally invisible to
 *        /job and /appointment?jobId= — this is the only way to discover
 *        one, which is what service_opportunities is built on)
 *       (+ embedded serviceLine/deficiency/changeOrder/contract/serviceRecurrence
 *          each fanned into their own table; embedded job/location stub-inserted
 *          into jobs/locations ONLY if missing — never overwritten, since the
 *          job-detail fetch is authoritative for those rows;
 *          embedded preferredTechs[] resolved against technicians during normalize)
 *
 * ServiceTrade's /job/{id} and /appointment?jobId= responses come in two
 * real shapes, confirmed against two different real accounts:
 *  - FLAT: the job/appointment IS the response body, with every reference
 *    (customer/vendor/location/owner/sales/techs/etc) already embedded as a
 *    full nested object.
 *  - COMPOUND: `{ job: {...bare numeric-id references...}, locations: [],
 *    companies: [], contacts: [], users: [], serviceRequests: [] }` — the
 *    real objects are side-loaded in sibling arrays, and the job/appointment
 *    only carries their ids.
 * flattenJobDetail/flattenAppointmentEntry below resolve either shape into
 * one fully-embedded object so every mapper/upsert past that point is
 * written against a single shape and doesn't need to know which one a given
 * account returned.
 *
 * Pagination is handled via ServiceTrade's `page`/`totalPages` response shape.
 * 429 / 5xx responses are retried with exponential backoff. Per-entity cursors
 * are tracked in `servicetrade_sync_state` so subsequent runs are incremental.
 */
const stClient      = require("./servicetrade");
const credentialsDb = require("../db/servicetrade-credentials");
const syncDb        = require("../db/servicetrade-sync");
const logger        = require("../utils/logger");
const { mapWithConcurrency } = require("../utils/concurrency");

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_MS  = 2000;

// How many ServiceTrade requests are in flight at once for the per-entity
// fetches (job detail, appointments-per-job, comments-per-job, customer
// record, contact roster). A full sync is dominated by these — roughly
// 3 calls per job plus 2 per distinct customer — and each one is a mostly-idle
// network wait, so raising this shortens wall time close to linearly until
// ServiceTrade starts pushing back.
//
// Measured on a real account (40 jobs, /comment fetch, run in both ascending
// and descending order to cancel out the cold-connection penalty that
// otherwise flatters whichever level runs first):
//   5 → ~4200ms   10 → ~2100-3700ms   15 → ~1650-1940ms   20 → ~1500ms
// Zero 429s at every level and identical row counts throughout, so 15 is
// ~2.4x faster than 5 with 20 showing clear diminishing returns.
//
// Caveat: that was a 40-call burst. A full sync is ~3 calls/job + 2/customer
// (~770 for a 180-job account), and ServiceTrade's sustained-rate behaviour
// is NOT verified — if 429s start appearing, drop this via env rather than
// editing code. requestWithRetry already backs off exponentially on 429/5xx,
// so an over-aggressive value degrades into retries rather than lost data.
const API_CONCURRENCY = Math.max(1, Number(process.env.SERVICETRADE_SYNC_CONCURRENCY) || 15);
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
 * Like fetchAllPages, but ALSO accumulates ServiceTrade's compound-document
 * side-loaded sibling arrays (locations/companies/contacts/users/
 * serviceRequests) across every page, keyed by id — needed for endpoints
 * whose real objects may be side-loaded rather than embedded (see module
 * doc). A flat-shape response simply has none of these sibling arrays, so
 * `sideLoad` ends up with empty maps and every resolveRef() call below falls
 * through to the embedded object it already had.
 */
async function fetchAllPagesWithSideLoad(companyId, pathPrefix, listKey, credentials, params = {}) {
  const all = [];
  const sideLoad = { locations: new Map(), companies: new Map(), contacts: new Map(), users: new Map(), serviceRequests: new Map() };
  let page = 1;
  let complete = true;
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
    const list = Array.isArray(res.data?.[listKey]) ? res.data[listKey] : [];
    all.push(...list);
    for (const key of Object.keys(sideLoad)) {
      for (const item of Array.isArray(res.data?.[key]) ? res.data[key] : []) {
        if (item && item.id != null) sideLoad[key].set(Number(item.id), item);
      }
    }
    const totalPages = Number(res.data?.totalPages) || 1;
    if (page >= totalPages || list.length === 0) break;
    page++;
  }
  return { rows: all, sideLoad, complete };
}

// ── Shape resolution (flat vs compound — see module doc) ───────────────────

function buildSideLoadIndex(raw, key) {
  const m = new Map();
  for (const item of Array.isArray(raw?.[key]) ? raw[key] : []) {
    if (item && item.id != null) m.set(Number(item.id), item);
  }
  return m;
}

/** `ref` is either already a full object (flat shape) or a bare id (compound shape). */
function resolveRef(ref, index) {
  if (ref == null) return null;
  if (typeof ref === "object") return ref;
  return (index && index.get(Number(ref))) || { id: ref };
}

function resolveRefList(refs, index) {
  if (!Array.isArray(refs)) return [];
  return refs.map((r) => resolveRef(r, index)).filter(Boolean);
}

/** Wraps a bare id as {id} so callers can always treat tags[] as objects, regardless of shape. */
function asObj(ref) {
  return ref == null ? null : (typeof ref === "object" ? ref : { id: ref });
}

/**
 * Resolves a /job/{id} response (either shape) into one fully-embedded job
 * object. See module doc for the two real shapes this handles.
 */
function flattenJobDetail(raw) {
  if (!raw) return null;
  const job = raw.job && typeof raw.job === "object" ? { ...raw.job } : { ...raw };

  const locations       = buildSideLoadIndex(raw, "locations");
  const companies       = buildSideLoadIndex(raw, "companies");
  const contacts        = buildSideLoadIndex(raw, "contacts");
  const users           = buildSideLoadIndex(raw, "users");
  const serviceRequests = buildSideLoadIndex(raw, "serviceRequests");

  job.customer       = resolveRef(job.customer, companies);
  job.vendor         = resolveRef(job.vendor, companies);
  job.owner          = resolveRef(job.owner, users);
  job.sales          = resolveRef(job.sales, users);
  job.primaryContact = resolveRef(job.primaryContact, contacts);
  job.office         = resolveRef(job.office ?? job.assignedOffice, locations);
  job.offices        = resolveRefList(job.offices, locations);
  job.tags           = Array.isArray(job.tags) ? job.tags.map(asObj) : [];
  job.notes             = Array.isArray(job.notes) ? job.notes : [];
  job.schedulingComments = Array.isArray(job.schedulingComments) ? job.schedulingComments : [];
  job.serviceRequests = resolveRefList(job.serviceRequests, serviceRequests);

  const location = resolveRef(job.location, locations);
  job.location = location ? { ...location } : null;
  if (job.location) {
    job.location.company        = resolveRef(job.location.company, companies);
    job.location.primaryContact = job.location.primaryContact
      ? resolveRef(job.location.primaryContact, contacts)
      : (job.primaryContact || null);
    job.location.contacts = resolveRefList(job.location.contacts, contacts);
    job.location.offices  = resolveRefList(job.location.offices, locations);
    job.location.tags     = Array.isArray(job.location.tags) ? job.location.tags.map(asObj) : [];
  }
  return job;
}

/**
 * Resolves one entry of a /appointment?jobId= response's `appointments[]`
 * list (either shape) into a fully-embedded appointment object. `sideLoad`
 * is shared across the whole response (built once per call by
 * fetchAllPagesWithSideLoad, not per appointment).
 */
function flattenAppointmentEntry(a, sideLoad) {
  if (!a) return null;
  const out = { ...a };
  out.location = resolveRef(out.location, sideLoad.locations);
  out.vendor   = resolveRef(out.vendor, sideLoad.companies);
  out.techs    = resolveRefList(out.techs, sideLoad.users);
  out.offices  = resolveRefList(out.offices, sideLoad.locations);
  out.serviceRequests = resolveRefList(out.serviceRequests, sideLoad.serviceRequests);
  out.notes = Array.isArray(out.notes) ? out.notes : [];
  return out;
}

// ── Entity mappers (raw API row → DB row) ───────────────────────────────────

function mapCustomerRow(c) {
  return {
    servicetrade_id: Number(c.id),
    full_name:       c.name ?? null,
    email:           c.primaryEmail ?? c.email ?? null,
    phone:           c.phoneNumber ?? c.phone ?? null,
    address_line1:   c.address?.street ?? c.addressStreet ?? null,
    city:            c.address?.city ?? c.addressCity ?? null,
    state:           c.address?.state ?? c.addressState ?? null,
    zipcode:         c.address?.postalCode ?? c.addressPostalCode ?? null,
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

/** job.owner / job.sales — ServiceTrade "User", not the same shape as a technician. */
function mapUserRow(u) {
  return {
    servicetrade_id: Number(u.id),
    name:            u.name ?? null,
    email:           u.email ?? null,
    status:          u.status ?? null,
    is_tech:         u.isTech ?? null,
    is_helper:       u.isHelper ?? null,
    payload:         u,
  };
}

/** job.project: {id, uri, startDate, endDate}. */
function mapProjectRow(p) {
  return {
    servicetrade_id: Number(p.id),
    start_date:      p.startDate ? new Date(p.startDate * 1000).toISOString() : null,
    end_date:        p.endDate   ? new Date(p.endDate   * 1000).toISOString() : null,
    payload:         p,
  };
}

/**
 * appointment.techs[] — the only technician source now (job.owner/sales are
 * crm_users, not technicians). Some accounts' techs[] embed only gives a
 * combined `name` ("Alex Pearson") with no firstName/lastName split — split
 * it ourselves rather than lose the name entirely.
 */
function mapTechnicianRow(u) {
  let firstName = u.firstName ?? null;
  let lastName  = u.lastName  ?? null;
  if (!firstName && !lastName && u.name) {
    const parts = String(u.name).trim().split(/\s+/);
    firstName = parts[0] || null;
    lastName  = parts.slice(1).join(" ") || null;
  }
  return {
    servicetrade_id: Number(u.id),
    first_name:      firstName,
    last_name:       lastName,
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
    address_line1:                  l.address?.street ?? l.addressStreet ?? null,
    city:                            l.address?.city ?? l.addressCity ?? null,
    state:                           l.address?.state ?? l.addressState ?? null,
    zipcode:                        l.address?.postalCode ?? l.addressPostalCode ?? null,
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
    phone:           c.phone ?? c.phoneNumber ?? null,
    mobile:          c.mobile ?? null,
    alternate_phone: c.alternatePhone ?? null,
    email:           c.email ?? null,
    type:            c.type ?? null,
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
    address_line1:   o.address?.street ?? o.addressStreet ?? null,
    city:            o.address?.city ?? o.addressCity ?? null,
    state:           o.address?.state ?? o.addressState ?? null,
    zipcode:         o.address?.postalCode ?? o.addressPostalCode ?? null,
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

// ServiceTrade's entity type for a Job on /comment — mirrors the seeded
// servicetrade_entity_type_config row (entity_key='job'). Inlined here
// rather than read from the DB: this runs inside the per-job fetch loop, and
// the value is a fixed part of ServiceTrade's API contract, not tenant config.
const ENTITY_TYPE_JOB = 3;

/**
 * One /comment row → raw table row. `payload` keeps the whole comment
 * (content/created/updated/author/visibility/pinned) for the normalize step.
 *
 * The job id comes from the comment's OWN `entity.id` when present, not the
 * job we happened to query by: the same comment id is sometimes returned
 * under more than one job (verified — 2 of 259 across a 25-job sample), and
 * `entity` is the authoritative owner. Falling back to the queried id keeps
 * this safe if the field is ever missing.
 */
function mapJobCommentRow(c, servicetradeJobId) {
  if (!c || c.id == null) return null;
  return {
    servicetrade_id:     String(c.id),
    servicetrade_job_id: String(c.entity?.id ?? servicetradeJobId),
    payload:             c,
  };
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
    address_line1:   l.address?.street ?? l.addressStreet ?? null,
    city:            l.address?.city ?? l.addressCity ?? null,
    state:           l.address?.state ?? l.addressState ?? null,
    zipcode:         l.address?.postalCode ?? l.addressPostalCode ?? null,
    country:         l.address?.country ?? "US",
    taxable:         l.taxable ?? null,
    status:          l.status ?? null,
    is_active:       l.status ? l.status === "active" : l.active !== false,
    payload:         l,
  };
}

/**
 * `opts.appointmentId`/`opts.jobId` are set when this row comes from a job
 * or appointment detail fetch rather than the /servicerequest list — those
 * nested serviceRequests[] entries have no `job` field of their own, so the
 * parent's job id is passed in explicitly. An options OBJECT (not a
 * positional param) is used deliberately: the existing
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

/**
 * ServiceTrade `type` job types that put a technician on-site to do physical
 * work — the only jobs relevant to confirmation calls. Excludes types with
 * no technician site visit at all (administrative, design, sales, delivery/
 * pickup logistics, consultation, monitoring, quality_assurance, training,
 * unknown).
 */
const TECHNICIAN_JOB_TYPES = [
  "buildout", "cleaning", "construction", "emergency_service_call", "exchange", "hookup",
  "inspection", "inspection_repair", "installation", "planned_maintenance", "preventative_maintenance",
  "priority_inspection", "priority_service_call", "reinspection", "repair", "replacement", "retrofit",
  "service_call", "start_up", "survey", "testing", "upgrade", "urgent_service_call", "warranty",
];

/**
 * Build /job query params. Defaults to scoping the fetch to the current
 * calendar month — e.g. today = Aug 3 → only jobs scheduled through Aug 31,
 * NOT a rolling 30-day window that would spill into September. Callers can
 * override with an explicit `scheduleDateFrom`/`scheduleDateTo` (unix
 * seconds) for a custom window instead (e.g. backfilling a past month) — a
 * custom window is a *windowed full* pull: runSync drops the updatedAfter
 * cursor for it and freezes the cursor afterwards (see runSync).
 * `type` (technician-site-visit job types — see TECHNICIAN_JOB_TYPES) and
 * `status=scheduled` always apply, full sync or not — only the date window
 * is omitted when `full` is true, same convention as buildServiceRequestParams.
 * `scheduleDateFrom`/`scheduleDateTo` (jobs with an appointment scheduled in
 * this window) is the right date filter here, not dueByBegin/End (job
 * deadline) or completedOnBegin/End (irrelevant since status=scheduled
 * already excludes completed jobs).
 */
function buildJobParams({ full = false, scheduleDateFrom = null, scheduleDateTo = null } = {}) {
  const params = { status: "scheduled", type: TECHNICIAN_JOB_TYPES.join(",") };
  if (full) return params;
  if (scheduleDateFrom != null || scheduleDateTo != null) {
    if (scheduleDateFrom != null) params.scheduleDateFrom = String(scheduleDateFrom);
    if (scheduleDateTo != null) params.scheduleDateTo = String(scheduleDateTo);
    return params;
  }
  const now = new Date();
  const nowUnix = Math.floor(now.getTime() / 1000);
  const endOfMonthUnix = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000) - 1;
  params.scheduleDateFrom = String(nowUnix - 5 * 60); // small buffer, avoid clock-skew gaps
  params.scheduleDateTo   = String(endOfMonthUnix);
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

  // Targeted mode: refresh exactly these ServiceTrade job ids and nothing else.
  // Presence of the KEY decides the mode, not its length — an empty array must
  // sync nothing, never silently fall through to the whole month window, which
  // is what a webhook drain that resolved no job ids would otherwise trigger.
  const targeted = Array.isArray(options.jobIds);
  // An explicit scheduleDateFrom/To replaces the default current-calendar-month
  // window. That makes the run a *windowed full* pull rather than an
  // incremental one — see the cursor handling at the end of this function.
  const customWindow = !targeted && (options.scheduleDateFrom != null || options.scheduleDateTo != null);
  // Kept as STRINGS. ServiceTrade ids are ~2.3e15 — Number() is exact there
  // today but only just, and a silently rounded id would fetch the wrong job.
  // The id is only ever interpolated into a URL path, so nothing needs it
  // numeric.
  const targetedJobIds = targeted
    ? [...new Set(options.jobIds.map(String).filter((s) => /^[0-9]{1,19}$/.test(s)))]
    : null;
  if (targeted && targetedJobIds.length === 0) {
    return { success: true, counts: {}, incomplete: [], targeted: true, skipped: "no job ids" };
  }

  const credentials = await credentialsDb.getByCompanyId(companyId);
  if (!credentials) return { success: false, error: "ServiceTrade not connected" };

  const state = await syncDb.getSyncState(companyId);
  const counts = {
    customers: 0, jobs: 0, appointments: 0, technicians: 0, locations: 0, contacts: 0, offices: 0, tags: 0,
    users: 0, projects: 0,
    serviceRequests: 0, serviceLines: 0, deficiencies: 0, changeOrders: 0, contracts: 0, serviceRecurrences: 0,
    appointmentServiceLines: 0, appointmentServiceRequests: 0, jobComments: 0,
  };
  // Tracks which entities' fetches ran to completion this pass — an entity's
  // cursor only advances if its own fetch was complete (see fetchAllPages doc).
  // customers/locations/contacts/offices/tags/technicians have no cursor of
  // their own anymore — they're derived from the jobs/appointments fetches.
  const complete = { jobs: true, appointments: true, serviceRequests: true };

  logger.info("ServiceTrade sync starting", {
    companyId, mode: full ? "full" : "incremental", range, customWindow,
    ...(customWindow ? { scheduleDateFrom: options.scheduleDateFrom, scheduleDateTo: options.scheduleDateTo } : {}),
  });

  try {
    // --- Jobs: ids (/job) → full detail per job (/job/{id}) ----------------
    // /job's list response only embeds a thin per-job shape. The full detail
    // response (serviceRequests[]/notes[]/schedulingComments[]/tags[]/project/
    // contract/externalIds/owner/sales/office/number/currentAppointment, plus
    // customer/location — see module doc for the two response shapes) is
    // only available per-id, so the list is used solely to know which job ids
    // are new/updated this pass (still incremental via updatedAfter), and
    // every one of those ids gets a bounded-concurrency detail fetch.
    // `status` is a ServiceTrade array-type filter, but a single value is
    // unambiguous regardless of the array's wire serialization — only
    // "scheduled" jobs are synced (ServiceTrade also supports "*" for every
    // status and "all" for every status except canceled, unused here).
    // scheduleDateFrom/To additionally scope incremental runs to the current
    // calendar month by default (see buildJobParams) — callers can pass
    // options.scheduleDateFrom/scheduleDateTo (unix seconds) for a custom
    // window instead. A full sync still fetches every scheduled job
    // regardless of date, same convention as /servicerequest.
    //
    // A custom window deliberately drops the updatedAfter cursor: a backfill
    // asking for July AND "updated since yesterday" returns nearly nothing,
    // which is the opposite of what the caller asked for. The window itself is
    // the scope, so the whole window is re-pulled.
    //
    // options.jobIds skips this list call entirely and syncs exactly those job
    // ids — the webhook path, where ServiceTrade has already told us WHICH job
    // changed. Everything downstream is untouched: the whole graph around a job
    // (appointments, customer, location, contacts, offices, tags, technicians,
    // comments) fans out from the per-id detail fetch below, so a targeted run
    // refreshes all of it without a second code path to keep in step.
    if (engine) await engine.transition("fetching_jobs", { full });
    let jobStubs;
    let jobListComplete;
    if (targeted) {
      jobStubs = targetedJobIds.map((id) => ({ id }));
      jobListComplete = true;
      logger.info("ServiceTrade sync: targeted job ids", { companyId, count: jobStubs.length });
    } else {
      logger.info("ServiceTrade sync: fetching jobs", { companyId });
      ({ rows: jobStubs, complete: jobListComplete } = await fetchAllPages(companyId, "/job", "jobs", credentials, {
        ...buildJobParams({ full, scheduleDateFrom: options.scheduleDateFrom, scheduleDateTo: options.scheduleDateTo }),
        ...(full || customWindow ? {} : cursorParams(state?.last_jobs_updated_at)),
      }));
    }
    complete.jobs = jobListComplete;

    let jobs = [];
    if (jobStubs.length) {
      if (engine) await engine.transition("fetching_job_details", { count: jobStubs.length });
      logger.info("ServiceTrade sync: fetching job details", { companyId, count: jobStubs.length });
      const jobDetailResults = await mapWithConcurrency(jobStubs, API_CONCURRENCY, async (j) => {
        const res = await requestWithRetry(companyId, "GET", `/job/${j.id}`, {}, credentials);
        return res.ok ? flattenJobDetail(res.data) : null;
      });
      jobs = jobDetailResults.filter(Boolean);
      // A job whose detail fetch failed didn't get written this pass — don't
      // advance the jobs cursor so it's retried on the next incremental run.
      if (jobs.length < jobStubs.length) complete.jobs = false;

      await syncDb.upsertJobsBatch(companyId, jobs.map(mapJobRow));
      counts.jobs = jobs.length;

      // Fan out every entity embedded/side-loaded on the job detail, deduped
      // by servicetrade_id — this replaces the old dedicated /company,
      // /location, and /user?isTech=true calls entirely.
      const customersById = new Map();
      const locationsById = new Map();
      const contactsById  = new Map();
      const usersById      = new Map();
      const projectsById   = new Map();
      const officesById    = new Map();
      const tagsById        = new Map();
      // contact id -> { companies: Map, locations: Map } accumulated across
      // EVERY job the contact appears on, then stamped onto the contact's
      // payload below. This is the only source of contact↔customer and
      // contact↔location linkage: the flat /job/{id} contact embeds carry no
      // `company`/`location` of their own (only the standalone /contact
      // endpoint does, and we deliberately don't call it), so the association
      // has to be inferred from the parent job that the contact came from.
      const contactLinksById = new Map();
      const linkContact = (contact, { customer, location }) => {
        if (contact?.id == null) return;
        contactsById.set(contact.id, contact);
        let links = contactLinksById.get(contact.id);
        if (!links) {
          links = { companies: new Map(), locations: new Map() };
          contactLinksById.set(contact.id, links);
        }
        if (customer?.id != null) links.companies.set(customer.id, customer);
        if (location?.id != null) {
          // Strip the nested contact back-reference — it would round-trip the
          // whole location object into every contact's payload otherwise.
          const { primaryContact, contacts, ...locRef } = location;
          links.locations.set(location.id, locRef);
        }
      };

      for (const j of jobs) {
        if (j.customer?.id != null) customersById.set(j.customer.id, j.customer);
        if (j.owner?.id != null) usersById.set(j.owner.id, j.owner);
        if (j.sales?.id != null) usersById.set(j.sales.id, j.sales);
        if (j.project?.id != null) projectsById.set(j.project.id, j.project);
        if (j.office?.id != null) officesById.set(j.office.id, j.office);
        for (const o of Array.isArray(j.offices) ? j.offices : []) {
          if (o && o.id != null) officesById.set(o.id, o);
        }
        for (const t of Array.isArray(j.tags) ? j.tags : []) {
          if (t && t.id != null) tagsById.set(t.id, t);
        }
        // Job-level primaryContact — a full contact object, and often the ONLY
        // contact on the job (location.primaryContact is frequently null).
        linkContact(j.primaryContact, { customer: j.customer, location: j.location });
        if (j.location?.id != null) {
          // The flat /job/{id} shape omits `location.company`, which used to
          // come from the dedicated /location fetch — without it every
          // locations.customer_id normalized to NULL. The job carries both its
          // customer and its location, so borrow the customer from here.
          const location = j.location.company ? j.location : { ...j.location, company: j.customer ?? null };
          locationsById.set(location.id, location);
          linkContact(j.location.primaryContact, { customer: j.customer, location: j.location });
          for (const c of Array.isArray(j.location.contacts) ? j.location.contacts : []) {
            linkContact(c, { customer: j.customer, location: j.location });
          }
          for (const o of Array.isArray(j.location.offices) ? j.location.offices : []) {
            if (o && o.id != null) officesById.set(o.id, o);
          }
          for (const t of Array.isArray(j.location.tags) ? j.location.tags : []) {
            if (t && t.id != null) tagsById.set(t.id, t);
          }
        }
      }

      // job.customer is a lightweight {id,name,status} stub — no phone, no
      // address, ever (verified live against multiple real jobs/customers).
      // The full company record (phone, address, refNumber, customer/vendor
      // flags) only exists at GET /company/{id}. One request per DISTINCT
      // customer seen this run (not per job) — mirrors the /contact fetch
      // below. Concurrency-limited like the job-detail fetches above; a
      // failed lookup just keeps the lightweight stub rather than failing
      // the whole sync (mapCustomerRow already tolerates missing fields).
      const distinctCustomerIds = Array.from(customersById.keys());
      const enrichedCustomers = await mapWithConcurrency(distinctCustomerIds, API_CONCURRENCY, async (custId) => {
        const res = await requestWithRetry(companyId, "GET", `/company/${custId}`, {}, credentials);
        return res.ok && res.data ? [custId, res.data] : null;
      });
      for (const entry of enrichedCustomers) {
        if (entry) customersById.set(entry[0], entry[1]);
        // else: lookup failed — the lightweight stub already in customersById stays.
      }

      // A customer company's FULL contact roster is NOT obtainable from
      // /job/{id} either — same lightweight-stub limitation as above.
      // Everything captured earlier only ever came from a job/location
      // specifically referencing a contact (primaryContact /
      // location.contacts[]), so a customer's other real contacts (a VP, a
      // PM, an assistant super who was never a job's primary contact) are
      // invisible without this call. One request per DISTINCT customer seen
      // this run (not per job) — a customer with 50 jobs still costs exactly
      // 1 call.
      // Fetch every customer's roster concurrently, then apply the results
      // serially below. The fetch is pure I/O and parallelises cleanly; the
      // loop body is NOT safe to parallelise — it mutates shared
      // contactsById/contactLinksById state, and linkContact's
      // read-modify-write on those Maps would interleave. Splitting the two
      // keeps the mutation order byte-identical to the old sequential
      // version (mapWithConcurrency preserves input order in its results)
      // while overlapping the network waits, which were previously fully
      // serial — one round trip per customer, the slowest thing in the sync.
      const contactRosters = await mapWithConcurrency(
        Array.from(customersById.entries()),
        API_CONCURRENCY,
        async ([custId, customer]) => {
          const { rows, complete } = await fetchAllPages(
            companyId, "/contact", "contacts", credentials, { companyId: String(custId) }
          );
          return { custId, customer, rows, complete };
        }
      );

      for (const { custId, customer, rows: companyContacts, complete: contactsComplete } of contactRosters) {
        if (!contactsComplete) {
          logger.warn("ServiceTrade: customer contact roster fetch incomplete", { companyId, customerId: custId });
        }
        for (const c of companyContacts) {
          if (c?.id == null) continue;
          contactsById.set(c.id, c);
          // This endpoint (unlike job-embedded contact stubs) returns real
          // companies[]/locations[] on the contact itself — link the
          // customer this request was explicitly scoped to as a guaranteed
          // floor, plus whatever the response itself reports, in case a
          // contact spans more than one company/location.
          linkContact(c, { customer, location: null });
          for (const comp of Array.isArray(c.companies) ? c.companies : []) {
            linkContact(c, { customer: comp, location: null });
          }
          for (const loc of Array.isArray(c.locations) ? c.locations : []) {
            linkContact(c, { customer: null, location: loc });
          }
        }
      }

      if (customersById.size) {
        await syncDb.upsertCustomersBatch(companyId, Array.from(customersById.values()).map(mapCustomerRow));
        counts.customers = customersById.size;
      }
      // Locations are only upserted here (never from the appointment fetch
      // below) — their customer_id is a flat overwrite on conflict (no
      // COALESCE), and only the job detail has the customer available to
      // resolve it correctly.
      if (locationsById.size) {
        await syncDb.upsertLocationsBatch(companyId, Array.from(locationsById.values()).map(mapLocationRow));
        counts.locations = locationsById.size;
      }
      if (contactsById.size) {
        // `companies`/`locations` are the plural forms _normalizeContactJunctions
        // already reads (it prefers them over the singular `company`/`location`),
        // so the contact_companies / contact_locations junctions populate from
        // these without any change to the normalize layer.
        const contactRows = Array.from(contactsById.values()).map((c) => {
          const links = contactLinksById.get(c.id);
          return mapContactRow({
            ...c,
            companies: links ? Array.from(links.companies.values()) : [],
            locations: links ? Array.from(links.locations.values()) : [],
          });
        });
        await syncDb.upsertContactsBatch(companyId, contactRows);
        counts.contacts = contactRows.length;
      }
      if (usersById.size) {
        await syncDb.upsertUsersBatch(companyId, Array.from(usersById.values()).map(mapUserRow));
        counts.users = usersById.size;
      }
      if (projectsById.size) {
        await syncDb.upsertProjectsBatch(companyId, Array.from(projectsById.values()).map(mapProjectRow));
        counts.projects = projectsById.size;
      }
      if (officesById.size) {
        await syncDb.upsertOfficesBatch(companyId, Array.from(officesById.values()).map(mapOfficeRow));
        counts.offices += officesById.size;
      }
      if (tagsById.size) {
        await syncDb.upsertTagsBatch(companyId, Array.from(tagsById.values()).map(mapTagRow));
        counts.tags += tagsById.size;
      }
    }
    logger.info("ServiceTrade sync: wrote jobs", {
      companyId, table: "servicetrade_jobs", count: counts.jobs, complete: complete.jobs,
      fanOut: { customers: counts.customers, locations: counts.locations, contacts: counts.contacts, users: counts.users, projects: counts.projects, offices: counts.offices, tags: counts.tags },
    });
    if (engine) {
      await engine.emit("fetched", { entity: "jobs", count: counts.jobs });
      await engine.emit("fetched", { entity: "customers", count: counts.customers });
      await engine.emit("fetched", { entity: "locations", count: counts.locations });
      await engine.emit("fetched", { entity: "contacts", count: counts.contacts });
      await engine.emit("fetched", { entity: "users", count: counts.users });
      await engine.emit("fetched", { entity: "projects", count: counts.projects });
    }

    // --- Appointments per job (/appointment?jobId={id}) --------------------
    // Replaces both the old embedded-on-/job appointment extraction and the
    // narrow-window per-appointment-ID detail fetch, AND is now the only
    // technician source (techs[] → servicetrade_technicians) — replaces the
    // old dedicated /user?isTech=true call.
    if (jobs.length) {
      if (engine) await engine.transition("fetching_appointments", { count: jobs.length });
      logger.info("ServiceTrade sync: fetching appointments per job", { companyId, jobs: jobs.length });
      let appointmentsIncomplete = false;
      const perJobAppts = await mapWithConcurrency(jobs, API_CONCURRENCY, async (j) => {
        const { rows, sideLoad, complete: ok } = await fetchAllPagesWithSideLoad(companyId, "/appointment", "appointments", credentials, { jobId: String(j.id) });
        if (!ok) appointmentsIncomplete = true;
        // Per-job completeness, kept separate from the global flag: the stale
        // prune below may only run for jobs whose OWN fetch paged all the way
        // through. A partial fetch looks identical to "these appointments were
        // deleted", and acting on it would delete live visits.
        return { rows: rows.map((a) => flattenAppointmentEntry(a, sideLoad)), complete: ok };
      });
      complete.appointments = !appointmentsIncomplete;

      // ── Appointments deleted in the CRM ────────────────────────────────
      // /appointment?jobId= returns a job's COMPLETE appointment set, so an
      // appointment we hold that the response no longer contains has been
      // deleted upstream. Nothing else can tell us: every write in this engine
      // is an upsert, so a vanished appointment would otherwise sit in the
      // platform as `scheduled` forever and stay eligible to be confirmed and
      // called. ServiceTrade's `deleted` webhook covers the same ground but
      // only while messages are actually delivered — it discards a message
      // after 3 failed attempts — whereas this needs no event at all.
      for (let i = 0; i < jobs.length; i++) {
        const perJob = perJobAppts[i];
        if (!perJob?.complete) continue;
        // Every id must be usable. Filtering a bad one OUT of the keep-set
        // would silently promote "we could not read this id" into "delete this
        // appointment" — the same class of mistake as treating a truncated
        // fetch as a deletion. If anything is unreadable, trust none of it.
        const keep = perJob.rows.map((a) => String(a?.id));
        if (!keep.every((id) => /^[0-9]+$/.test(id))) {
          logger.warn("ServiceTrade sync: unreadable appointment id, skipping delete detection for this job", {
            companyId, jobId: String(jobs[i].id), ids: keep,
          });
          continue;
        }
        const { removed, cancelled } = await syncDb.reconcileAppointmentsForJob(companyId, String(jobs[i].id), keep);
        if (removed.length) {
          counts.appointmentsDeleted = (counts.appointmentsDeleted || 0) + removed.length;
          logger.info("ServiceTrade sync: appointments deleted upstream", {
            companyId, jobId: String(jobs[i].id), removed, cancelledInPlatform: cancelled,
          });
        }
      }

      // Keyed by id, not pushed to arrays: the same appointment/service-request
      // can legitimately appear on more than one per-job fetch page (and the
      // same service request can be embedded on more than one of a job's
      // appointments) — a duplicate servicetrade_id within one batch INSERT
      // makes Postgres error with "ON CONFLICT DO UPDATE command cannot
      // affect row a second time", so de-dupe before upserting.
      const apptRowsById = new Map();
      const techniciansById = new Map();
      const apptOfficesById = new Map();
      const apptServiceLinesById = new Map();
      const apptServiceRequestRowsById = new Map();
      for (let i = 0; i < jobs.length; i++) {
        const jobId = Number(jobs[i].id);
        for (const a of (perJobAppts[i]?.rows || [])) {
          if (!a || a.id == null) continue;
          apptRowsById.set(Number(a.id), mapAppointmentRow(a, jobId));
          for (const t of Array.isArray(a.techs) ? a.techs : []) {
            if (t && t.id != null) techniciansById.set(t.id, t);
          }
          for (const o of Array.isArray(a.offices) ? a.offices : []) {
            if (o && o.id != null) apptOfficesById.set(o.id, o);
          }
          for (const r of Array.isArray(a.serviceRequests) ? a.serviceRequests : []) {
            if (r?.id == null) continue;
            if (r.serviceLine?.id != null) apptServiceLinesById.set(r.serviceLine.id, r.serviceLine);
            apptServiceRequestRowsById.set(Number(r.id), mapServiceRequestRow(r, { appointmentId: Number(a.id), jobId }));
          }
        }
      }
      const apptRows = Array.from(apptRowsById.values());
      const apptServiceRequestRows = Array.from(apptServiceRequestRowsById.values());
      if (apptRows.length) {
        await syncDb.upsertAppointmentsBatch(companyId, apptRows);
        counts.appointments = apptRows.length;
      }
      if (techniciansById.size) {
        await syncDb.upsertTechniciansBatch(companyId, Array.from(techniciansById.values()).map(mapTechnicianRow));
        counts.technicians = techniciansById.size;
      }
      if (apptOfficesById.size) {
        await syncDb.upsertOfficesBatch(companyId, Array.from(apptOfficesById.values()).map(mapOfficeRow));
        counts.offices += apptOfficesById.size;
      }
      if (apptServiceLinesById.size) {
        await syncDb.upsertServiceLinesBatch(companyId, Array.from(apptServiceLinesById.values()).map(mapServiceLineRow));
        counts.appointmentServiceLines = apptServiceLinesById.size;
      }
      if (apptServiceRequestRows.length) {
        await syncDb.upsertServiceRequestsBatch(companyId, apptServiceRequestRows);
        counts.appointmentServiceRequests = apptServiceRequestRows.length;
      }
      logger.info("ServiceTrade sync: wrote appointments", {
        companyId, count: counts.appointments, complete: complete.appointments,
        technicians: counts.technicians,
        appointmentServiceLines: counts.appointmentServiceLines, appointmentServiceRequests: counts.appointmentServiceRequests,
      });
      if (engine) {
        await engine.emit("fetched", { entity: "appointments", count: counts.appointments });
        await engine.emit("fetched", { entity: "technicians", count: counts.technicians });
        await engine.emit("fetched", { entity: "appointment_service_requests", count: counts.appointmentServiceRequests });
      }
    }

    // --- Job comments (/comment?entityType=3&entityId={job}) ---------------
    // ServiceTrade's REAL comment stream. /job/{id}'s notes[]/schedulingComments[]
    // are routinely empty even on jobs with a full comment history (verified
    // live), so this endpoint is the only way to see what CSRs/techs actually
    // wrote — which is what job confirmation inference reads
    // (services/job-confirmation-inference.js).
    //
    // entityType 3 = Job (servicetrade_entity_type_config). No updatedAfter
    // filter exists on /comment, so there's no cursor: the work is naturally
    // scoped to whichever jobs this run's incremental job fetch returned.
    // A failed page only drops that job's comments for this pass — it does
    // NOT mark the jobs cursor incomplete, since jobs themselves synced fine
    // and the next run re-fetches comments for whatever jobs come back then.
    if (jobs.length) {
      if (engine) await engine.transition("fetching_job_comments", { count: jobs.length });
      logger.info("ServiceTrade sync: fetching job comments", { companyId, jobs: jobs.length });
      const jobCommentEntityType = String(ENTITY_TYPE_JOB);
      const perJobComments = await mapWithConcurrency(jobs, API_CONCURRENCY, async (j) => {
        const { rows } = await fetchAllPages(companyId, "/comment", "comments", credentials, {
          entityType: jobCommentEntityType,
          entityId: String(j.id),
          sort: "created",
        });
        return rows.map((c) => mapJobCommentRow(c, j.id)).filter(Boolean);
      });
      // Keyed by comment id, not just flattened: the same comment can come
      // back under more than one job's fetch, and a duplicate
      // servicetrade_id inside one batch INSERT makes Postgres error with
      // "ON CONFLICT DO UPDATE command cannot affect row a second time" —
      // the same de-dupe every other entity here already does.
      const commentRowsById = new Map();
      for (const row of perJobComments.flat()) commentRowsById.set(row.servicetrade_id, row);
      const commentRows = Array.from(commentRowsById.values());
      if (commentRows.length) {
        await syncDb.upsertJobCommentsBatch(companyId, commentRows);
        counts.jobComments = commentRows.length;
      }
      logger.info("ServiceTrade sync: wrote job comments", {
        companyId, table: "servicetrade_job_comments", count: counts.jobComments,
      });
      if (engine) await engine.emit("fetched", { entity: "job_comments", count: counts.jobComments });
    }

    // --- Service requests + embedded sub-objects (/servicerequest) ---------
    // DISABLED. This standalone fetch existed to discover job-less service
    // requests (structurally invisible to /job and /appointment?jobId=) —
    // the basis of service_opportunities, whose normalize step is now also
    // removed (see crm/servicetrade/provider.js's normalizeAll).
    //
    // Appointment-linked service requests are UNAFFECTED: the /appointment
    // fetch above already writes them into the same
    // servicetrade_service_requests table (with servicetrade_appointment_id
    // set), which is exactly what _normalizeAppointmentServices reads —
    // so appointment_services, and the service_line it feeds into both
    // agents' context, keep working.
    //
    // Side effect of disabling this: the fan-out below was the only source
    // for servicetrade_deficiencies / _change_orders / _contracts /
    // _service_recurrences, so those stop refreshing too. Their only reader
    // outside the sync is db/service-opportunities.js — i.e. the same
    // service-opportunity feature already left on stale data — so nothing
    // else degrades. Re-enable by uncommenting this block.
    /*
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
      // Insert-only stubs (never overwrite rows already synced via /job).
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
    */

    // Bump cursors to "now" ONLY for entities whose fetch actually completed —
    // an incomplete entity keeps its old cursor so the next incremental run's
    // updatedAfter window re-covers whatever pages were missed this time,
    // instead of silently skipping them forever. customers/locations/
    // contacts/offices/tags/technicians have no cursor of their own — they're
    // derived from jobs/appointments, so they're implicitly re-covered
    // whenever those cursors re-cover a job.
    const now = Math.floor(Date.now() / 1000);
    const incomplete = Object.entries(complete).filter(([, ok]) => !ok).map(([entity]) => entity);

    // A targeted run touches NO cursor and NO sync-status field. It covered one
    // or two specific jobs, so advancing last_jobs_updated_at to now would tell
    // the next incremental run that everything up to this moment is already
    // handled — silently losing every OTHER job that changed since the last
    // real sync. It also must not write last_sync_at, which the UI presents as
    // "everything is up to date as of then".
    if (targeted) {
      logger.info("ServiceTrade targeted sync done", { companyId, jobIds: targetedJobIds, counts });
      return { success: true, counts, incomplete, targeted: true };
    }

    // A custom-window run touches NO cursor and NO last_sync_at, for the same
    // reason a targeted run doesn't: it covered one date window, not
    // "everything up to now". Advancing last_jobs_updated_at after a July-only
    // backfill would tell the next incremental run that every change up to this
    // moment is handled, silently dropping every job OUTSIDE the window that
    // changed since the last real sync. last_sync_at is likewise the UI's
    // "everything is up to date as of then", which a backfill did not earn.
    // The status/error fields ARE written — the run genuinely succeeded or
    // failed and that's worth surfacing.
    await syncDb.updateSyncState(companyId, {
      last_sync_at:                  customWindow ? undefined : now,
      last_full_sync_at:             customWindow ? undefined : (full ? now : (state?.last_full_sync_at ?? null)),
      last_sync_status:              incomplete.length ? "partial" : "success",
      last_sync_error:               incomplete.length ? `Incomplete entities (cursor not advanced): ${incomplete.join(", ")}` : null,
      last_jobs_updated_at:          (customWindow || !complete.jobs)         ? undefined : now,
      last_appointments_updated_at:  (customWindow || !complete.appointments) ? undefined : now,
      // Deliberately NOT advanced while the /servicerequest fetch is disabled
      // above: bumping a cursor for an entity we never fetched would mean a
      // future re-enable resumes past everything that changed in the
      // meantime, silently losing it. Frozen here, so re-enabling picks up
      // from where the fetch actually last ran. (Not marked "incomplete" —
      // that's for genuine fetch failures, and would write a misleading
      // last_sync_error on every run.)
      last_service_requests_updated_at: undefined,
    });

    if (incomplete.length) {
      logger.warn("ServiceTrade sync partially incomplete — will retry these entities next run", { companyId, incomplete, counts });
    } else {
      logger.info("ServiceTrade sync done", { companyId, counts, mode: full ? "full" : "incremental", customWindow });
    }
    return { success: true, counts, incomplete, ...(customWindow ? { customWindow: true } : {}) };
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
  buildJobParams,
};
