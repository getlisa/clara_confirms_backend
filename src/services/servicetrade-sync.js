/**
 * ServiceTrade sync: fetch from API with rate limit/retries, persist via servicetrade-sync DB.
 *
 * Incremental sync strategy (ported from clara-lead-agent-server):
 *   - Per-entity dual cursors: createdAfter + updatedAfter
 *   - 5-minute overlap buffer to avoid missing records at boundary
 *   - Fetch both windows in parallel, merge by ServiceTrade ID to deduplicate
 *   - Falls back to full fetch when no cursors exist (first sync)
 *   - Sync status tracking: running / success / failed
 */

const servicetrade = require("./servicetrade");
const credentialsDb = require("../db/servicetrade-credentials");
const syncDb = require("../db/servicetrade-sync");
const db = require("../db/index");
const logger = require("../utils/logger");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const PAGE_SIZE = 200;
const CURSOR_OVERLAP_SECONDS = 300; // 5-minute overlap to avoid missing records

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Cursor helpers (from clara-lead-agent-server)
// ============================================================================

/**
 * Build a cursor value with overlap buffer.
 * Subtracts CURSOR_OVERLAP_SECONDS to avoid missing records at the boundary.
 * @param {number|null|undefined} value — stored cursor (Unix seconds)
 * @returns {number|undefined}
 */
function buildCursor(value) {
  if (value == null) return undefined;
  const normalized = Number(value) - CURSOR_OVERLAP_SECONDS;
  return normalized > 0 ? normalized : 0;
}

/**
 * Extract the maximum timestamp from API records.
 * @param {Array} records — API records with created/updated fields
 * @param {'created'|'updated'} key
 * @returns {number|null}
 */
function getMaxTimestamp(records, key) {
  return records.reduce((max, record) => {
    const value = record[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return max;
    }
    return max == null ? value : Math.max(max, value);
  }, null);
}

/**
 * Merge multiple record arrays by ServiceTrade ID, deduplicating.
 * Later records override earlier ones with the same ID.
 * @param  {...Array} recordSets
 * @returns {Array}
 */
function mergeRecordsById(...recordSets) {
  const merged = new Map();
  for (const records of recordSets) {
    for (const record of records) {
      const id = record.id != null ? record.id : parseIdFromUri(record.uri);
      if (id == null) continue;
      merged.set(id, record);
    }
  }
  return Array.from(merged.values());
}

// ============================================================================
// API helpers
// ============================================================================

/**
 * Request with retry on 429 and 5xx (exponential backoff).
 */
async function requestWithRetry(companyId, method, path, options = {}, credentials = null) {
  let lastStatus;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await servicetrade.request(companyId, method, path, options, credentials);
      lastStatus = result.status;
      if (result.ok) return result;
      const retryable = result.status === 429 || (result.status >= 500 && result.status < 600);
      if (!retryable || attempt === MAX_RETRIES) return result;
      const wait = RETRY_DELAY_MS * Math.pow(2, attempt);
      logger.warn("ServiceTrade request retry", {
        companyId,
        method,
        path,
        status: result.status,
        attempt: attempt + 1,
        waitMs: wait,
      });
      await delay(wait);
    } catch (error) {
      const wait = RETRY_DELAY_MS * Math.pow(2, attempt);
      const retryableNetworkError =
        error &&
        (error.name === "ServiceTradeFetchError" ||
          /fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_|socket/i.test(error.message || ""));
      if (!retryableNetworkError || attempt === MAX_RETRIES) {
        throw error;
      }
      logger.warn("ServiceTrade network retry", {
        companyId,
        method,
        path,
        attempt: attempt + 1,
        waitMs: wait,
        error: error.message,
        code: error.code,
        details: error.details,
      });
      await delay(wait);
    }
  }
  return { ok: false, status: lastStatus, data: null, messages: {} };
}

/**
 * Fetch all pages of a list resource.
 */
async function fetchAllPages(companyId, pathPrefix, listKey, credentials, params = {}) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  do {
    const qs = new URLSearchParams({ page, limit: PAGE_SIZE, ...params });
    const path = `${pathPrefix}?${qs}`;
    const result = await requestWithRetry(companyId, "GET", path, {}, credentials);
    if (!result.ok) {
      const details = {
        companyId,
        path,
        status: result.status,
        messages: result.messages,
      };
      logger.error("ServiceTrade paged fetch failed", details);
      const error = new Error(`ServiceTrade ${path} failed: ${result.status}`);
      error.details = details;
      throw error;
    }
    const data = result.data || {};
    totalPages = data.totalPages != null ? data.totalPages : 1;
    const list = data[listKey] || data[listKey.replace(/s$/, "")] || [];
    items.push(...(Array.isArray(list) ? list : []));
    page++;
  } while (page <= totalPages);
  return items;
}

/**
 * Fetch records using dual cursors: createdAfter + updatedAfter in parallel,
 * then merge by ServiceTrade ID to deduplicate.
 * Falls back to full fetch when no cursors exist.
 *
 * @param {string|number} companyId
 * @param {string} pathPrefix — e.g. "/company"
 * @param {string} listKey — e.g. "companies"
 * @param {object} credentials
 * @param {{ createdAfter?: number, updatedAfter?: number }} cursorState
 * @param {object} [extraParams] — additional query params (e.g. { status: "open,..." })
 * @returns {Promise<Array>}
 */
async function fetchIncrementalRecords(companyId, pathPrefix, listKey, credentials, cursorState, extraParams = {}) {
  const requests = [];

  if (cursorState.createdAfter != null) {
    requests.push(
      fetchAllPages(companyId, pathPrefix, listKey, credentials, {
        createdAfter: cursorState.createdAfter,
        ...extraParams,
      })
    );
  }

  if (cursorState.updatedAfter != null) {
    requests.push(
      fetchAllPages(companyId, pathPrefix, listKey, credentials, {
        updatedAfter: cursorState.updatedAfter,
        ...extraParams,
      })
    );
  }

  // No cursors → full fetch
  if (requests.length === 0) {
    return fetchAllPages(companyId, pathPrefix, listKey, credentials, extraParams);
  }

  const results = await Promise.all(requests);
  return mergeRecordsById(...results);
}

// ============================================================================
// Record parsing helpers
// ============================================================================

function parseIdFromUri(uri) {
  if (!uri || typeof uri !== "string") return null;
  const m = uri.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : null;
}

function unixToTimestamp(unixSeconds) {
  if (unixSeconds == null) return null;
  const d = new Date(unixSeconds * 1000);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function parseEntityId(entity) {
  if (!entity || typeof entity !== "object") return null;
  if (entity.id != null) {
    const parsed = Number(entity.id);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return parseIdFromUri(entity.uri);
}

function uniqueIds(ids) {
  return [...new Set(ids.filter((id) => id != null))];
}

// ============================================================================
// Main sync
// ============================================================================

/**
 * Run full or incremental sync.
 * @param {string|number} companyId — Clara tenant id
 * @param {{ full?: boolean }} options — full=true forces full sync
 * @returns {Promise<{ success: boolean, counts?: object, error?: string }>}
 */
async function runSync(companyId, options = {}) {
  const full = !!options.full;
  const credentials = await credentialsDb.getByCompanyId(companyId);
  if (!credentials) {
    return { success: false, error: "ServiceTrade not connected" };
  }

  const syncState = await syncDb.getSyncState(companyId);

  // Build per-entity cursors
  const companyCursor = full
    ? {}
    : {
        createdAfter: buildCursor(syncState?.last_companies_created_at),
        updatedAfter: buildCursor(syncState?.last_companies_updated_at),
      };
  const locationCursor = full
    ? {}
    : {
        createdAfter: buildCursor(syncState?.last_locations_created_at),
        updatedAfter: buildCursor(syncState?.last_locations_updated_at),
      };
  const contactCursor = full
    ? {}
    : {
        createdAfter: buildCursor(syncState?.last_contacts_created_at),
        updatedAfter: buildCursor(syncState?.last_contacts_updated_at),
      };
  const srCursor = full
    ? {}
    : {
        createdAfter: buildCursor(syncState?.last_service_requests_created_at),
        updatedAfter: buildCursor(syncState?.last_service_requests_updated_at),
      };
  const assetCursor = full
    ? {}
    : {
        createdAfter: buildCursor(syncState?.last_assets_created_at),
        updatedAfter: buildCursor(syncState?.last_assets_updated_at),
      };

  const isFreshSync = !syncState ||
    (companyCursor.createdAfter == null && companyCursor.updatedAfter == null);

  logger.info("ServiceTrade sync start", {
    companyId,
    full,
    isFreshSync,
    companyCursor,
    locationCursor,
  });

  try {
    // Mark sync as running
    await syncDb.updateSyncState(companyId, {
      last_sync_status: "running",
      last_sync_error: null,
    });

    // ---------- Phase 1: Fetch companies, locations, and service requests ----------
    // For service requests on fresh/full sync, limit to open statuses
    const srExtraParams = isFreshSync ? { status: "open,in_progress,pending" } : {};

    const [companies, locations, allSRs] = await Promise.all([
      fetchIncrementalRecords(companyId, "/company", "companies", credentials, companyCursor),
      fetchIncrementalRecords(companyId, "/location", "locations", credentials, locationCursor),
      fetchIncrementalRecords(companyId, "/servicerequest", "servicerequests", credentials, srCursor, srExtraParams),
    ]);

    // Map company rows with individual address columns
    const companyRows = companies
      .map((c) => {
        const id = c.id != null ? c.id : parseIdFromUri(c.uri);
        if (id == null) return null;
        return {
          servicetrade_id: id,
          name: c.name != null ? c.name : null,
          phone_number: c.phoneNumber != null ? c.phoneNumber : null,
          status: c.status != null ? c.status : null,
          ref_number: c.refNumber != null ? c.refNumber : null,
          street: c.address?.street ?? null,
          city: c.address?.city ?? null,
          state: c.address?.state ?? null,
          postal_code: c.address?.postalCode ?? null,
          country: c.address?.country ?? null,
          address: c.address != null ? c.address : null,
          is_active: c.status !== "inactive",
          is_deleted: false,
          payload: c,
        };
      })
      .filter(Boolean);

    await syncDb.upsertCompaniesBatch(companyId, companyRows);

    // Map location rows with individual address columns
    const locationRows = locations
      .map((loc) => {
        const id = loc.id != null ? loc.id : parseIdFromUri(loc.uri);
        const servicetradeCompanyId = parseEntityId(loc.company);
        if (id == null) return null;
        return {
          servicetrade_id: id,
          servicetrade_company_id: servicetradeCompanyId,
          name: loc.name != null ? loc.name : null,
          phone_number: loc.phoneNumber != null ? loc.phoneNumber : null,
          email: loc.email != null ? loc.email : null,
          status: loc.status != null ? loc.status : null,
          ref_number: loc.refNumber != null ? loc.refNumber : null,
          street: loc.address?.street ?? null,
          city: loc.address?.city ?? null,
          state: loc.address?.state ?? null,
          postal_code: loc.address?.postalCode ?? null,
          address: loc.address != null ? loc.address : null,
          is_active: true,
          is_deleted: false,
          payload: loc,
        };
      })
      .filter(Boolean);

    const locationIdByStId = await syncDb.upsertLocationsBatch(companyId, locationRows);

    // Map service request rows
    const srRows = allSRs
      .map((sr) => {
        const srId = sr.id != null ? sr.id : parseIdFromUri(sr.uri);
        const fromLoc = sr.location && (sr.location.id != null ? sr.location.id : parseIdFromUri(sr.location.uri));
        const locIdSt = fromLoc != null ? fromLoc : null;
        const locationId = locIdSt != null ? locationIdByStId.get(locIdSt) : null;
        if (srId == null || locationId == null) return null;
        const windowStart = sr.windowStart != null ? sr.windowStart : sr.window_start;
        const windowEnd = sr.windowEnd != null ? sr.windowEnd : sr.window_end;
        return {
          servicetrade_id: srId,
          location_id: locationId,
          job_id: sr.jobId != null ? sr.jobId : (sr.job_id != null ? sr.job_id : null),
          asset_id: sr.asset && (sr.asset.id != null ? sr.asset.id : parseIdFromUri(sr.asset.uri)),
          description: sr.description != null ? sr.description : null,
          status: sr.status != null ? sr.status : null,
          window_start: windowStart != null ? unixToTimestamp(windowStart) : null,
          window_end: windowEnd != null ? unixToTimestamp(windowEnd) : null,
          payload: sr,
        };
      })
      .filter(Boolean);

    await syncDb.upsertServiceRequestsBatch(companyId, srRows);

    // ---------- Phase 2: Fetch contacts and assets ----------
    const locationIdsSt = [...locationIdByStId.keys()];

    let assetPromises;
    if (!isFreshSync && (assetCursor.createdAfter != null || assetCursor.updatedAfter != null)) {
      // Incremental: use dual cursors for assets
      assetPromises = [
        fetchIncrementalRecords(companyId, "/asset", "assets", credentials, assetCursor).catch(() => []),
      ];
    } else {
      // Full: fetch per-location in batches
      assetPromises = [];
      for (let i = 0; i < locationIdsSt.length; i += 50) {
        const batch = locationIdsSt.slice(i, i + 50);
        assetPromises.push(
          fetchAllPages(companyId, "/asset", "assets", credentials, { locationId: batch.join(",") })
        );
      }
    }

    const [contacts, assetResults] = await Promise.all([
      fetchIncrementalRecords(companyId, "/contact", "contacts", credentials, contactCursor),
      Promise.all(assetPromises),
    ]);
    const assets = assetResults.flat();

    // Map contact rows with alternate_phone + servicetrade_company_id
    const contactRows = contacts
      .map((contact) => {
        const id = contact.id != null ? contact.id : parseIdFromUri(contact.uri);
        if (id == null) return null;
        const contactLocationIdsSt = uniqueIds([
          parseEntityId(contact.location),
          ...((Array.isArray(contact.locations) ? contact.locations : []).map(parseEntityId)),
        ]);
        const resolvedLocationIds = uniqueIds(
          contactLocationIdsSt
            .map((locationIdSt) => locationIdByStId.get(locationIdSt))
            .filter((locationId) => locationId != null)
        );
        const explicitCompanyIds = uniqueIds([
          parseEntityId(contact.company),
          ...((Array.isArray(contact.companies) ? contact.companies : []).map(parseEntityId)),
        ]);
        // Fallback: derive company from first linked location
        const fallbackCompanyId = contactLocationIdsSt
          .map((locStId) => {
            const locRow = locationRows.find((l) => l.servicetrade_id === locStId);
            return locRow?.servicetrade_company_id ?? null;
          })
          .find((cid) => cid != null);

        const contactType = contact.type != null ? contact.type : (contact.contactTypes && contact.contactTypes[0]);
        return {
          servicetrade_id: id,
          first_name:
            contact.firstName != null ? contact.firstName : (contact.first_name != null ? contact.first_name : null),
          last_name:
            contact.lastName != null ? contact.lastName : (contact.last_name != null ? contact.last_name : null),
          phone: contact.phone != null ? contact.phone : null,
          mobile: contact.mobile != null ? contact.mobile : null,
          alternate_phone: contact.alternatePhone != null ? contact.alternatePhone : null,
          email: contact.email != null ? contact.email : null,
          type: contactType != null ? contactType : null,
          servicetrade_company_id: explicitCompanyIds[0] ?? fallbackCompanyId ?? null,
          location_id: resolvedLocationIds[0] != null ? resolvedLocationIds[0] : null,
          linked_location_ids: resolvedLocationIds,
          linked_servicetrade_company_ids: uniqueIds([
            parseEntityId(contact.company),
            ...((Array.isArray(contact.companies) ? contact.companies : []).map(parseEntityId)),
          ]),
          payload: contact,
        };
      })
      .filter(Boolean);

    await syncDb.upsertContactsBatch(companyId, contactRows);

    // Build contact ID map
    const contactIdRows = await db.query(
      "SELECT id, servicetrade_id FROM servicetrade_contacts WHERE company_id = $1",
      [companyId]
    );
    const contactIdByStId = new Map();
    contactIdRows.rows.forEach((row) => contactIdByStId.set(Number(row.servicetrade_id), row.id));

    // Contact-location links
    const contactLocationLinks = [];
    const contactCompanyLinks = [];
    contactRows.forEach((row) => {
      const contactId = contactIdByStId.get(Number(row.servicetrade_id));
      if (!contactId) return;
      (row.linked_location_ids || []).forEach((locationId) => {
        contactLocationLinks.push({ contact_id: contactId, location_id: locationId });
      });
      (row.linked_servicetrade_company_ids || []).forEach((servicetradeCompanyId) => {
        contactCompanyLinks.push({
          contact_id: contactId,
          servicetrade_company_id: servicetradeCompanyId,
        });
      });
    });

    await syncDb.replaceContactLocationLinks(companyId, contactLocationLinks);
    await syncDb.replaceContactCompanyLinks(companyId, contactCompanyLinks);

    // Assets
    const srIdByStId = new Map();
    const srRowsDb = await db.query(
      "SELECT id, servicetrade_id FROM servicetrade_service_requests WHERE company_id = $1",
      [companyId]
    );
    srRowsDb.rows.forEach((row) => srIdByStId.set(Number(row.servicetrade_id), row.id));

    const assetRows = assets
      .map((asset) => {
        const id = asset.id != null ? asset.id : parseIdFromUri(asset.uri);
        const loc = asset.location || {};
        const locIdSt = loc.id != null ? loc.id : parseIdFromUri(loc.uri);
        const locationId = locationIdByStId.get(locIdSt);
        if (id == null || locationId == null) return null;
        const srIdSt =
          asset.serviceRequest &&
          (asset.serviceRequest.id != null ? asset.serviceRequest.id : parseIdFromUri(asset.serviceRequest.uri));
        const service_request_id = srIdSt != null ? srIdByStId.get(srIdSt) || null : null;
        return {
          servicetrade_id: id,
          location_id: locationId,
          service_request_id,
          name: asset.name != null ? asset.name : (asset.display != null ? asset.display : null),
          payload: asset,
        };
      })
      .filter(Boolean);

    await syncDb.upsertAssetsBatch(companyId, assetRows);

    // ---------- Recompute is_active for locations and companies ----------
    await syncDb.recomputeLocationIsActive(companyId);
    await syncDb.recomputeCompanyIsActive(companyId);

    // ---------- Persist per-entity cursors ----------
    const nowUnix = Math.floor(Date.now() / 1000);

    const cursorUpdates = {
      last_sync_at: nowUnix,
      last_sync_status: "success",
      last_sync_error: null,
    };

    // Only update cursors if we fetched records (avoid overwriting with null)
    const companiesMaxCreated = getMaxTimestamp(companies, "created");
    const companiesMaxUpdated = getMaxTimestamp(companies, "updated");
    if (companiesMaxCreated != null) cursorUpdates.last_companies_created_at = companiesMaxCreated;
    if (companiesMaxUpdated != null) cursorUpdates.last_companies_updated_at = companiesMaxUpdated;

    const locationsMaxCreated = getMaxTimestamp(locations, "created");
    const locationsMaxUpdated = getMaxTimestamp(locations, "updated");
    if (locationsMaxCreated != null) cursorUpdates.last_locations_created_at = locationsMaxCreated;
    if (locationsMaxUpdated != null) cursorUpdates.last_locations_updated_at = locationsMaxUpdated;

    const contactsMaxCreated = getMaxTimestamp(contacts, "created");
    const contactsMaxUpdated = getMaxTimestamp(contacts, "updated");
    if (contactsMaxCreated != null) cursorUpdates.last_contacts_created_at = contactsMaxCreated;
    if (contactsMaxUpdated != null) cursorUpdates.last_contacts_updated_at = contactsMaxUpdated;

    const srsMaxCreated = getMaxTimestamp(allSRs, "created");
    const srsMaxUpdated = getMaxTimestamp(allSRs, "updated");
    if (srsMaxCreated != null) cursorUpdates.last_service_requests_created_at = srsMaxCreated;
    if (srsMaxUpdated != null) cursorUpdates.last_service_requests_updated_at = srsMaxUpdated;

    const assetsMaxCreated = getMaxTimestamp(assets, "created");
    const assetsMaxUpdated = getMaxTimestamp(assets, "updated");
    if (assetsMaxCreated != null) cursorUpdates.last_assets_created_at = assetsMaxCreated;
    if (assetsMaxUpdated != null) cursorUpdates.last_assets_updated_at = assetsMaxUpdated;

    if (full) {
      cursorUpdates.last_full_sync_at = nowUnix;
    }

    await syncDb.updateSyncState(companyId, cursorUpdates);

    const counts = {
      companies: companies.length,
      locations: locations.length,
      service_requests: allSRs.length,
      contacts: contacts.length,
      assets: assets.length,
    };

    logger.info("ServiceTrade sync done", { companyId, counts, mode: full ? "full" : isFreshSync ? "initial" : "incremental" });
    return { success: true, counts };
  } catch (err) {
    logger.error("ServiceTrade sync error", {
      companyId,
      error: err.message,
      code: err.code,
      details: err.details,
      cause: err.cause && err.cause.message ? err.cause.message : undefined,
    });

    // Record failure in sync state
    await syncDb.updateSyncState(companyId, {
      last_sync_status: "failed",
      last_sync_error: (err.message || "ServiceTrade sync failed").slice(0, 1000),
    }).catch((e) => logger.error("Failed to update sync state on error", { error: e.message }));

    return { success: false, error: err.message };
  }
}

module.exports = {
  runSync,
  requestWithRetry,
  fetchAllPages,
};
