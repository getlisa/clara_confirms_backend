/**
 * ServiceTrade sync engine — simplified.
 *
 * Pulls 4 entities and writes them to the matching raw tables:
 *   GET /company             → servicetrade_customers
 *   GET /job                 → servicetrade_jobs (+ inline appointments → servicetrade_appointments)
 *   GET /user?isTech=true    → servicetrade_technicians
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
    const res = await stClient.request(companyId, method, path, opts, credentials);
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

/** Page through a list endpoint, returning all rows under `listKey`. */
async function fetchAllPages(companyId, pathPrefix, listKey, credentials, params = {}) {
  const all = [];
  let page = 1;
  // ServiceTrade caps page size around 200; using 100 is safe and small enough to retry cheaply.
  const PER_PAGE = 100;
  while (true) {
    const qs = new URLSearchParams({ ...params, page: String(page), perPage: String(PER_PAGE) }).toString();
    const path = `${pathPrefix}?${qs}`;
    const res = await requestWithRetry(companyId, "GET", path, {}, credentials);
    if (!res.ok) {
      logger.warn("ServiceTrade fetch failed", { companyId, path, status: res.status });
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
  return all;
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
  const credentials = await credentialsDb.getByCompanyId(companyId);
  if (!credentials) return { success: false, error: "ServiceTrade not connected" };

  const state = await syncDb.getSyncState(companyId);
  const counts = { customers: 0, jobs: 0, appointments: 0, technicians: 0 };

  try {
    // --- Customers (/company) ----------------------------------------------
    const customers = await fetchAllPages(companyId, "/company", "companies", credentials,
      full ? {} : cursorParams(state?.last_customers_updated_at));
    if (customers.length) {
      await syncDb.upsertCustomersBatch(companyId, customers.map(mapCustomerRow));
      counts.customers = customers.length;
    }

    // --- Technicians (/user?isTech=true) -----------------------------------
    const techs = await fetchAllPages(companyId, "/user", "users", credentials, { isTech: "true" });
    if (techs.length) {
      await syncDb.upsertTechniciansBatch(companyId, techs.map(mapTechnicianRow));
      counts.technicians = techs.length;
    }

    // --- Jobs + embedded appointments (/job) ------------------------------
    const jobs = await fetchAllPages(companyId, "/job", "jobs", credentials,
      full ? {} : cursorParams(state?.last_jobs_updated_at));
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

    // Update cursors (bump all to "now"; cursor refinement can be added later)
    const now = Math.floor(Date.now() / 1000);
    await syncDb.updateSyncState(companyId, {
      last_sync_at:                  now,
      last_full_sync_at:             full ? now : (state?.last_full_sync_at ?? null),
      last_sync_status:              "success",
      last_sync_error:               null,
      last_customers_updated_at:     now,
      last_jobs_updated_at:          now,
      last_appointments_updated_at:  now,
      last_technicians_updated_at:   now,
    });

    logger.info("ServiceTrade sync done", { companyId, counts, mode: full ? "full" : "incremental" });
    return { success: true, counts };
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
};
