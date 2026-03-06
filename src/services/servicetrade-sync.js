/**
 * ServiceTrade sync: fetch from API with rate limit/retries, persist via servicetrade-sync DB.
 * Full sync: fetch all; incremental: use updatedAfter (Unix seconds).
 */

const servicetrade = require("./servicetrade");
const credentialsDb = require("../db/servicetrade-credentials");
const syncDb = require("../db/servicetrade-sync");
const db = require("../db/index");
const logger = require("../utils/logger");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const PAGE_SIZE = 200;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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
 * Fetch all pages of a list resource. listKey = "companies" | "locations" | "servicerequests" | "contacts" | "assets" | "jobs"
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

/**
 * Run full or incremental sync.
 * @param {string|number} companyId - Clara tenant id
 * @param {{ full?: boolean }} options - full=true forces full sync
 * @returns {Promise<{ success: boolean, counts?: object, error?: string }>}
 */
async function runSync(companyId, options = {}) {
  const full = !!options.full;
  const credentials = await credentialsDb.getByCompanyId(companyId);
  if (!credentials) {
    return { success: false, error: "ServiceTrade not connected" };
  }

  const lastSyncAt = full ? null : await syncDb.getLastSyncAt(companyId);
  const isIncremental = !full && lastSyncAt != null && lastSyncAt > 0;

  logger.info("ServiceTrade sync start", { companyId, full, incremental: isIncremental, lastSyncAt });

  try {
    // ---------- Phase 1: Fetch companies, locations, and service requests in parallel ----------
    const companyParams = isIncremental && lastSyncAt ? { updatedAfter: lastSyncAt } : {};
    const locationParams = isIncremental && lastSyncAt ? { updatedAfter: lastSyncAt } : {};
    const srParams = isIncremental && lastSyncAt ? { updatedAfter: lastSyncAt } : { status: "open,in_progress,pending" };

    const [companiesResult, locationsResult, srResult] = await Promise.all([
      fetchAllPages(companyId, "/company", "companies", credentials, companyParams).catch((e) => {
        if (isIncremental && e.message && e.message.includes("failed")) {
          return fetchAllPages(companyId, "/company", "companies", credentials, {});
        }
        throw e;
      }),
      fetchAllPages(companyId, "/location", "locations", credentials, locationParams),
      fetchAllPages(companyId, "/servicerequest", "servicerequests", credentials, srParams).catch((e) => {
        if (isIncremental && e.message && e.message.includes("failed")) {
          return fetchAllPages(companyId, "/servicerequest", "servicerequests", credentials, {
            status: "open,in_progress,pending",
          });
        }
        throw e;
      }),
    ]);

    const companies = companiesResult;
    const locations = locationsResult;
    const allSRs = Array.isArray(srResult) ? srResult : [];

    const stCompanyIds = new Set();
    const companyRows = companies
      .map((c) => {
        const id = c.id != null ? c.id : parseIdFromUri(c.uri);
        if (id == null) return null;
        stCompanyIds.add(id);
        return {
          servicetrade_id: id,
          name: c.name != null ? c.name : null,
          phone_number: c.phoneNumber != null ? c.phoneNumber : null,
          address: c.address != null ? c.address : null,
          is_active: c.status !== "inactive",
          is_deleted: false,
          payload: c,
        };
      })
      .filter(Boolean);

    await syncDb.upsertCompaniesBatch(companyId, companyRows);

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
          address: loc.address != null ? loc.address : null,
          is_active: true,
          is_deleted: false,
          payload: loc,
        };
      })
      .filter(Boolean);

    const locationLinkingCounts = locationRows.reduce(
      (acc, row) => {
        if (row.servicetrade_company_id == null) {
          acc.unresolvedCount += 1;
        } else {
          acc.resolvedCount += 1;
        }
        return acc;
      },
      { resolvedCount: 0, unresolvedCount: 0 }
    );

    logger.info("ServiceTrade location-company linking", {
      companyId,
      resolvedCount: locationLinkingCounts.resolvedCount,
      unresolvedCount: locationLinkingCounts.unresolvedCount,
      ambiguousCount: 0,
    });

    const locationIdByStId = await syncDb.upsertLocationsBatch(companyId, locationRows);

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

    // ---------- Phase 2: Fetch contacts and assets once the location map exists ----------
    const locationIdsSt = [...locationIdByStId.keys()];
    let assetPromises;
    if (isIncremental && lastSyncAt) {
      assetPromises = [
        fetchAllPages(companyId, "/asset", "assets", credentials, { updatedAfter: lastSyncAt }).catch(() => []),
      ];
    } else {
      assetPromises = [];
      for (let i = 0; i < locationIdsSt.length; i += 50) {
        const batch = locationIdsSt.slice(i, i + 50);
        assetPromises.push(
          fetchAllPages(companyId, "/asset", "assets", credentials, { locationId: batch.join(",") })
        );
      }
    }

    const [contacts, assetResults] = await Promise.all([
      fetchAllPages(companyId, "/contact", "contacts", credentials, {}),
      Promise.all(assetPromises),
    ]);
    const assets = assetResults.flat();

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
        const contactType = contact.type != null ? contact.type : (contact.contactTypes && contact.contactTypes[0]);
        return {
          servicetrade_id: id,
          first_name:
            contact.firstName != null ? contact.firstName : (contact.first_name != null ? contact.first_name : null),
          last_name:
            contact.lastName != null ? contact.lastName : (contact.last_name != null ? contact.last_name : null),
          phone: contact.phone != null ? contact.phone : null,
          mobile: contact.mobile != null ? contact.mobile : null,
          email: contact.email != null ? contact.email : null,
          type: contactType != null ? contactType : null,
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

    const contactIdRows = await db.query(
      "SELECT id, servicetrade_id FROM servicetrade_contacts WHERE company_id = $1",
      [companyId]
    );
    const contactIdByStId = new Map();
    contactIdRows.rows.forEach((row) => contactIdByStId.set(Number(row.servicetrade_id), row.id));

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

    // ---------- Recompute is_active for all locations and companies ----------
    await syncDb.recomputeLocationIsActive(companyId);
    await syncDb.recomputeCompanyIsActive(companyId);

    const newLastSyncAt = Math.floor(Date.now() / 1000);
    await syncDb.setLastSyncAt(companyId, newLastSyncAt);

    const counts = {
      companies: companies.length,
      locations: locations.length,
      service_requests: allSRs.length,
      assets: assets.length,
    };

    logger.info("ServiceTrade sync done", { companyId, counts });
    return { success: true, counts };
  } catch (err) {
    logger.error("ServiceTrade sync error", {
      companyId,
      error: err.message,
      code: err.code,
      details: err.details,
      cause: err.cause && err.cause.message ? err.cause.message : undefined,
    });
    return { success: false, error: err.message };
  }
}

module.exports = {
  runSync,
  requestWithRetry,
  fetchAllPages,
};
