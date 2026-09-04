/**
 * InspectPoint raw sync engine.
 *
 * Structurally different from services/servicetrade-sync.js, not a port of
 * it: ServiceTrade is job-detail fan-out over a compound side-loaded document
 * (one /job/{id} call carries customer/location/contacts embedded); InspectPoint
 * is six independent flat, offset-paged lists with NO side-loading and NO
 * per-record detail fetch. The only structural parallel kept on purpose is the
 * "only advance a cursor when that entity's own fetch came back complete" rule.
 */

const ip = require("./inspectpoint");
const credsDb = require("../db/inspectpoint-credentials");
const syncDb = require("../db/inspectpoint-sync");
const { mapWithConcurrency } = require("../utils/concurrency");
const { tenantLocalDatePrefix } = require("./crm/inspectpoint/normalize");
const logger = require("../utils/logger");

const VISIT_CONCURRENCY = Math.max(1, Number(process.env.INSPECTPOINT_SYNC_CONCURRENCY) || 8);
const WINDOW_DAYS_BACK = 7;
const WINDOW_DAYS_FORWARD = 60;
const FULL_SYNC_MAX_AGE_DAYS = 7; // backstop for offset-pagination skew and the two entities with no time filter at all
const CURSOR_OVERLAP_MS = 5 * 60 * 1000; // absorbs rows written mid-run and clock skew, same idea as ServiceTrade's cursorParams()

/**
 * The statuses that count as open work, as InspectPoint's `status_name` filter
 * actually wants them.
 *
 * ⚠ THREE non-obvious rules here, all verified against the live API — getting
 * any of them wrong silently syncs EVERY inspection ever instead of erroring:
 *
 *  1. `status_name` takes ONE value per request. This was previously the single
 *     string "pending,scheduled", which matched no status at all.
 *  2. An unrecognised value is SILENTLY IGNORED — the API returns the full
 *     unfiltered result set rather than an error or an empty list. That is why
 *     the broken filter went unnoticed: it looked like a working sync.
 *  3. The value is matched against the status DISPLAY NAME, not the status
 *     code. Single-word codes work only because code == name; a multi-word
 *     code like `waiting_for_review` is ignored, while "Waiting for Review"
 *     works. These two happen to be single-word, but they are written as
 *     display names so the rule is visible to whoever adds a third.
 *
 * Because of (2) there is no server-side error signal to rely on, so every
 * response is re-checked client-side against the status it was requested with
 * (see fetchInspectionsByStatus).
 */
const OPEN_STATUS_NAMES = ["Pending", "Scheduled"];

/**
 * Above this many discovered inspections, fetch visits with ONE bulk paginated
 * pass (filtered client-side) instead of one request per inspection.
 *
 * `inspection_id` is optional on /v2/inspection_visits, so bulk costs
 * total_visits/100 regardless of how many inspections we found — 27 requests
 * for a real tenant's 2,599 visits. Fan-out costs one request per inspection,
 * so it only wins for a small set. 25 sits just under the bulk page count,
 * which is the break-even point.
 */
const BULK_VISIT_THRESHOLD = 25;

/**
 * Most inspections we'll individually re-fetch visits for after a bulk pull
 * left them with none (see the top-up in runSync). Normally 0-1; the cap stops
 * a tenant whose inspections genuinely have no visits from silently turning
 * the top-up into a second full fan-out.
 */
const VISIT_TOPUP_CAP = 200;

function isoDateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function withOverlap(isoString) {
  if (!isoString) return null;
  return new Date(new Date(isoString).getTime() - CURSOR_OVERLAP_MS).toISOString();
}

/**
 * Every row from every endpoint must have an `id` before it can become an
 * `inspectpoint_id` — a wrong list-vs-detail envelope assumption produces
 * `undefined` ids that would otherwise poison external_ref downstream. Any
 * bad row is dropped and the whole page's fetch is marked incomplete, so its
 * cursor doesn't advance and the next run retries it.
 */
function validateIds(rows, path) {
  const good = [];
  let bad = 0;
  for (const r of rows) {
    if (r && r.id != null) good.push(r);
    else bad++;
  }
  if (bad > 0) {
    logger.error("inspectpoint sync: rows with a missing id — dropped, entity marked incomplete", { path, bad, kept: good.length });
  }
  return { rows: good, complete: bad === 0 };
}

// ── Row mappers: InspectPoint API object -> inspectpoint_* raw row ──────────

function mapAccountRow(a) {
  return { inspectpointId: a.id, is_active: a.active !== false, payload: a, ipUpdatedAt: a.updated_at || null };
}

function mapBuildingRow(b) {
  return { inspectpointId: b.id, inspectpoint_customer_id: b.account_id ?? null, payload: b, ipUpdatedAt: b.updated_at || null };
}

function mapContactRow(c) {
  return { inspectpointId: c.id, inspectpoint_customer_id: c.account_id ?? null, payload: c, ipUpdatedAt: c.updated_at || null };
}

function mapTechnicianRow(t) {
  return { inspectpointId: t.id, is_active: t.active !== false, payload: t, ipUpdatedAt: t.updated_at || null };
}

function mapJobRow(i) {
  return {
    inspectpointId: i.id,
    inspectpoint_location_id: i.building_id ?? i.building?.id ?? null,
    inspectpoint_customer_id: i.building?.account_id ?? null,
    inspectpoint_technician_id: i.technician_id ?? null,
    status_code: i.status_code || null,
    scheduled_at: i.scheduled_time_iso || null,
    due_date: i.due_date || null,
    payload: i,
    ipUpdatedAt: i.updated_at || null,
  };
}

function mapVisitRow(v) {
  return {
    inspectpointId: v.id,
    inspectpoint_job_id: v.inspection_id ?? null,
    inspectpoint_technician_id: v.technician_id ?? null,
    visit_status: v.visit_status || null,
    scheduled_date: v.scheduled_date || null,
    payload: v,
    ipUpdatedAt: v.updated_at || null,
  };
}

const extractInspection = (d) => (Array.isArray(d?.inspections) ? d.inspections.map((w) => w.inspection) : []);

/**
 * One paged inspection fetch for ONE status, re-verified client-side.
 *
 * `statusName` must be a scalar string. Passing an array would serialise to
 * "Pending,Scheduled" via `searchParams.set(key, String(value))` in
 * services/inspectpoint.js — i.e. it would silently recreate the exact bug
 * this fan-out exists to fix — so that is asserted rather than assumed.
 *
 * Rows whose own `status_code` doesn't match what we asked for are dropped and
 * logged loudly: that is the ONLY signal available if InspectPoint renames a
 * status or the filter regresses, since the API answers an unrecognised
 * `status_name` with the full unfiltered set. Deliberately does NOT mark the
 * fetch incomplete — filtering client-side makes the result correct (just
 * expensive), whereas marking it incomplete would freeze the cursor forever
 * against a server that has genuinely changed behaviour.
 */
async function fetchInspectionsByStatus(companyId, statusName, extraParams, credentials) {
  if (typeof statusName !== "string" || !statusName.trim()) {
    throw new Error(`inspectpoint sync: status_name must be a non-empty string, got ${JSON.stringify(statusName)}`);
  }
  const fetched = await ip.fetchAllPages(
    companyId, "/external/api/v2/inspections",
    { status_name: statusName, ...extraParams },
    credentials, extractInspection
  );
  const wanted = statusName.toLowerCase().replace(/\s+/g, "_");
  const kept = fetched.rows.filter((r) => String(r?.status_code || "").toLowerCase() === wanted);
  if (kept.length !== fetched.rows.length) {
    logger.error("inspectpoint sync: /v2/inspections returned rows outside the requested status — the status_name filter was ignored server-side, falling back to client-side filtering", {
      companyId, statusName, requested: wanted, returned: fetched.rows.length, kept: kept.length,
      sampleForeignStatuses: [...new Set(fetched.rows.map((r) => r?.status_code).filter((s) => String(s || "").toLowerCase() !== wanted))].slice(0, 6),
    });
  }
  return { rows: kept, complete: fetched.complete };
}

/**
 * Pull from InspectPoint, populate the six raw tables. Mirrors ServiceTrade's
 * runSync(companyId, opts) -> {success, counts, incomplete} contract so
 * services/crm/inspectpoint/provider.js can drive it the same way
 * ServiceTradeProvider drives services/servicetrade-sync.js.
 *
 * @param {string|number} companyId
 * @param {{full?: boolean, engine?: object, scheduleDateFrom?: number, scheduleDateTo?: number}} [opts] —
 *   `engine` (a workflow-engine instance, see engines/crm-sync) receives the
 *   same transition/emit calls used by the ServiceTrade path; omitted for the
 *   silent cron path. `scheduleDateFrom`/`scheduleDateTo` (unix seconds,
 *   inclusive — the same param names/units engines/crm-sync already passes to
 *   every provider) request a custom inspections/visits window in place of
 *   the default rolling WINDOW_DAYS_BACK/WINDOW_DAYS_FORWARD one — see
 *   routes/inspectpoint.js's /sync route for where these come from.
 */
async function runSync(companyId, { full = false, engine = null, scheduleDateFrom = null, scheduleDateTo = null } = {}) {
  const credentials = await credsDb.getByCompanyId(companyId);
  if (!credentials) return { success: false, error: "InspectPoint not connected" };

  const state = await syncDb.getSyncState(companyId);
  const lastFullSyncAt = state?.last_full_sync_at ? new Date(state.last_full_sync_at) : null;
  const staleFull = !lastFullSyncAt || Date.now() - lastFullSyncAt.getTime() > FULL_SYNC_MAX_AGE_DAYS * 86400000;
  // A caller-specified window is its own third mode (see routes/inspectpoint.js's
  // resolveSyncRange) — never let the staleFull backstop silently upgrade it to
  // a full sync. That would advance last_full_sync_at even though the
  // inspections/visits fetch below only covers the caller's narrow window, not
  // the true universe of open work, suppressing a legitimately-due full pull
  // for up to FULL_SYNC_MAX_AGE_DAYS more.
  const customWindow = scheduleDateFrom != null || scheduleDateTo != null;
  const isFull = full || (staleFull && !customWindow);
  const runStartedAt = new Date();

  logger.info("inspectpoint sync starting", {
    companyId, mode: full ? "full" : "incremental", customWindow,
    ...(customWindow ? { scheduleDateFrom, scheduleDateTo } : {}),
  });

  const counts = {};
  const complete = { customers: true, locations: true, jobs: true };

  try {
    // ── Accounts ────────────────────────────────────────────────────────────
    if (engine) await engine.transition("fetching_accounts", {});
    const accountsCursor = isFull ? null : withOverlap(state?.last_customers_updated_at);
    const accountsFetch = await ip.fetchAllPages(
      companyId, "/external/api/v1/accounts",
      accountsCursor ? { updated_at_start: accountsCursor } : {},
      credentials, (d) => d.accounts
    );
    const accounts = validateIds(accountsFetch.rows, "/v1/accounts");
    complete.customers = accountsFetch.complete && accounts.complete;
    await syncDb.upsertRawBatch("inspectpoint_customers", ["is_active"], companyId, accounts.rows.map(mapAccountRow));
    counts.customers = accounts.rows.length;
    if (engine) await engine.emit("fetched", { entity: "accounts", count: counts.customers });

    // ── Buildings ───────────────────────────────────────────────────────────
    if (engine) await engine.transition("fetching_buildings", {});
    const buildingsCursor = isFull ? null : withOverlap(state?.last_locations_updated_at);
    const buildingsFetch = await ip.fetchAllPages(
      companyId, "/external/api/v1/buildings",
      buildingsCursor ? { updated_at_start: buildingsCursor } : {},
      credentials, (d) => d.buildings
    );
    const buildings = validateIds(buildingsFetch.rows, "/v1/buildings");
    complete.locations = buildingsFetch.complete && buildings.complete;
    await syncDb.upsertRawBatch("inspectpoint_locations", ["inspectpoint_customer_id"], companyId, buildings.rows.map(mapBuildingRow));
    counts.locations = buildings.rows.length;
    if (engine) await engine.emit("fetched", { entity: "buildings", count: counts.locations });

    // ── Contacts — no incremental filter exists on this endpoint; full pull every run ──
    if (engine) await engine.transition("fetching_contacts", {});
    const contactsFetch = await ip.fetchAllPages(companyId, "/external/api/v1/contacts", {}, credentials, (d) => d.contacts);
    const contacts = validateIds(contactsFetch.rows, "/v1/contacts");
    await syncDb.upsertRawBatch("inspectpoint_contacts", ["inspectpoint_customer_id"], companyId, contacts.rows.map(mapContactRow));
    counts.contacts = contacts.rows.length;
    if (engine) await engine.emit("fetched", { entity: "contacts", count: counts.contacts });

    // ── Technicians — bare array, no incremental filter, full pull every run ──
    if (engine) await engine.transition("fetching_technicians", {});
    const techniciansFetch = await ip.fetchAllPages(companyId, "/external/api/v1/technicians", {}, credentials, (d) => d);
    const technicians = validateIds(techniciansFetch.rows, "/v1/technicians");
    await syncDb.upsertRawBatch("inspectpoint_technicians", ["is_active"], companyId, technicians.rows.map(mapTechnicianRow));
    counts.technicians = technicians.rows.length;
    if (engine) await engine.emit("fetched", { entity: "technicians", count: counts.technicians });

    // ── Inspections — two passes, unioned. Pass A catches edits anywhere in
    // time via the cursor; Pass B unconditionally re-covers the operational
    // calendar window regardless of updated_at, so a change that doesn't
    // touch updated_at (rare, but the API gives no guarantee) is still caught. ──
    if (engine) await engine.transition("fetching_inspections", {});
    const now = new Date();
    const windowStart = customWindow
      ? isoDateOnly(new Date(scheduleDateFrom * 1000))
      : isoDateOnly(new Date(now.getTime() - WINDOW_DAYS_BACK * 86400000));
    const windowEnd = customWindow
      ? isoDateOnly(new Date(scheduleDateTo * 1000))
      : isoDateOnly(new Date(now.getTime() + WINDOW_DAYS_FORWARD * 86400000));
    const jobsCursor = (isFull || customWindow) ? null : withOverlap(state?.last_jobs_updated_at);

    // One request PER STATUS per pass (status_name takes a single value), all
    // issued concurrently. Running them together rather than sequentially also
    // minimises the window in which a row transitioning Pending -> Scheduled
    // could slip past both paginations' offsets.
    //
    // A custom window deliberately drops pass A's updated_at_start cursor —
    // same reasoning as servicetrade-sync.js's buildJobParams: "June AND
    // edited since yesterday" would return almost nothing, the opposite of
    // what a backfill asked for. The window itself is the scope, so the whole
    // window is re-pulled via pass B alone.
    const passAFetches = customWindow
      ? []
      : OPEN_STATUS_NAMES.map((s) =>
          fetchInspectionsByStatus(companyId, s, jobsCursor ? { updated_at_start: jobsCursor } : {}, credentials));
    const passBFetches = OPEN_STATUS_NAMES.map((s) =>
      fetchInspectionsByStatus(companyId, s, { scheduled_date_start: windowStart, scheduled_date_end: windowEnd }, credentials));

    const [passAResults, passBResults] = await Promise.all([
      Promise.all(passAFetches),
      Promise.all(passBFetches),
    ]);

    // Flattened PER PASS, not all together: pass B's rows get a client-side
    // window check below that must never be applied to pass A's (pass A is
    // deliberately not date-bound).
    const passA = {
      rows: passAResults.flatMap((r) => r.rows),
      complete: passAResults.every((r) => r.complete),
    };
    const passB = {
      rows: passBResults.flatMap((r) => r.rows),
      complete: passBResults.every((r) => r.complete),
    };

    // Defensive: pass B's entire reason for existing is "scheduled within
    // this exact window" — never trust InspectPoint's own scheduled_date_start/
    // scheduled_date_end filter blindly, since a loose or misinterpreted
    // server-side filter would otherwise silently pull in (or, for a custom
    // range, backfill) inspections outside the range the caller actually
    // asked for. Pass A is deliberately NOT date-bound (it exists to catch
    // edits anywhere in time regardless of schedule), so this check applies
    // to pass B's rows only — an inspection with no scheduled_time_iso at all
    // can't be verified as "in the window" and is dropped from this pass too.
    const passBInWindow = passB.rows.filter((row) => {
      const scheduledDate = tenantLocalDatePrefix(row?.scheduled_time_iso);
      const inWindow = !!scheduledDate && scheduledDate >= windowStart && scheduledDate <= windowEnd;
      if (!inWindow) {
        logger.warn("inspectpoint sync: dropping an inspection outside the requested scheduled-date window", {
          companyId, inspectionId: row?.id, scheduledDate, windowStart, windowEnd,
        });
      }
      return inWindow;
    });

    // Dedupe across passes AND across statuses. Last-write-wins is no longer
    // safe now that each status is its own request: an inspection that
    // transitions Pending -> Scheduled mid-run can legitimately appear in both
    // status fetches carrying DIFFERENT status_codes, and blindly taking the
    // later one could write back the staler row — leaving the job `open`
    // locally for another whole sync interval. Prefer the newer updated_at.
    const byId = new Map();
    for (const row of [...passA.rows, ...passBInWindow]) {
      if (row?.id == null) continue;
      const held = byId.get(row.id);
      if (!held || new Date(row.updated_at || 0) >= new Date(held.updated_at || 0)) {
        byId.set(row.id, row);
      }
    }
    const inspections = validateIds([...byId.values()], "/v2/inspections");
    // One `every` over every sub-fetch, not per-pass: `Pending` is ~99.7% of
    // open work, so advancing the cursor because `Scheduled` happened to
    // succeed would permanently lose every pending inspection edited in that
    // window.
    complete.jobs = [...passAResults, ...passBResults].every((r) => r.complete) && inspections.complete;

    // NOTE: there is deliberately no inspection-type resolution pass here.
    // An earlier version fetched /v1/inspections/settings once per run and
    // joined it to each row's `inspection_type_id`. Verified against the live
    // API, that could never work and was costing a request per sync for
    // nothing: no inspection response carries `inspection_type_id` at all
    // (checked on /v1/inspections, /v2/inspections and /v2/inspections/{id}),
    // the spec itself marks the `inspection_type` object nullable, and
    // settings returns `inspection_types` as an array of ARRAYS, not the
    // {id, name} objects that loop assumed — so every job silently ended up
    // with a null type. normalize.js's deriveInspectionLabel now works the
    // label out from the `frequency` object that IS on every row, and still
    // prefers a real `inspection_type.name` for any tenant that has one.
    await syncDb.upsertRawBatch(
      "inspectpoint_jobs",
      ["inspectpoint_location_id", "inspectpoint_customer_id", "inspectpoint_technician_id", "status_code", "scheduled_at", "due_date"],
      companyId, inspections.rows.map(mapJobRow)
    );
    counts.jobs = inspections.rows.length;
    if (engine) await engine.emit("fetched", { entity: "inspections", count: counts.jobs });

    // We now fetch ONLY open statuses, which means we never again observe an
    // inspection transitioning to cancelled/completed — its local copy just
    // stops being refreshed and keeps its last-known status. Detecting that
    // costs nothing (pass B is authoritative for its window), but ACTING on it
    // would be unsafe: absence and a half-failed page are indistinguishable,
    // so inferring "cancelled" could cancel live work. Warn only.
    //
    // Gated on complete.jobs — with an incomplete pull the "not seen" set is
    // meaningless — and skipped for a custom window, where pass B covers only
    // the caller's narrow backfill range so absence proves nothing.
    if (complete.jobs && !customWindow) {
      const seen = new Set(inspections.rows.map((i) => String(i.id)));
      const locallyOpen = await syncDb
        .listOpenInspectionIdsInWindow(companyId, `${windowStart}T00:00:00Z`, `${windowEnd}T23:59:59Z`)
        .catch(() => []);
      const vanished = locallyOpen.filter((id) => !seen.has(id));
      if (vanished.length) {
        logger.warn("inspectpoint sync: locally-open inspections in the window were NOT returned by a complete open-status pull — they are probably cancelled/completed upstream, or their date moved. Their local status is now stale; no status was changed.", {
          companyId, count: vanished.length, sampleInspectionIds: vanished.slice(0, 10), windowStart, windowEnd,
        });
      }
    }

    // ── Inspection visits — per-inspection fan-out (no bulk endpoint, same
    // shape as ServiceTrade's per-job appointment fetch), bounded concurrency.
    //
    // `inspection_id` is OPTIONAL on this endpoint, so there are two ways to
    // get visits and the cheap one depends on how many inspections we found:
    //
    //   bulk    — one paginated pass over every visit, filtered client-side.
    //             Cost is total_visits/100, INDEPENDENT of inspection count.
    //             Measured on a real tenant: 2,599 visits in 27 requests, ~10s.
    //   fan-out — one request per inspection. Cost is the inspection count.
    //             Measured: ~1,600 requests, minutes, and it timed out.
    //
    // So fan-out only wins for a genuinely small discovery set (a narrow
    // custom-range backfill). Above that, bulk is ~60x cheaper — which is what
    // lets every inspection keep its visits, including recurring compliance
    // work booked years out, instead of trading correctness for sync time. ──
    const discoveredIds = new Set(inspections.rows.map((i) => i.id));
    const useBulk = inspections.rows.length > BULK_VISIT_THRESHOLD;

    if (engine) await engine.transition("fetching_inspection_visits", { count: inspections.rows.length });
    logger.info("inspectpoint sync: fetching visits", {
      companyId, strategy: useBulk ? "bulk" : "per-inspection", inspections: inspections.rows.length,
    });

    let visitsComplete = true;
    let rawVisits = [];
    if (useBulk) {
      const bulk = await ip.fetchAllPages(companyId, "/external/api/v2/inspection_visits", {}, credentials, (d) => d);
      if (!bulk.complete) {
        // Either a page failed or we hit fetchAllPages' 20,000-row backstop.
        // Marking incomplete keeps the cursor from advancing over visits we
        // never saw; a tenant that genuinely exceeds that cap needs the
        // endpoint's own date filter, which it does not currently offer.
        visitsComplete = false;
        logger.error("inspectpoint sync: bulk visit pull incomplete — some visits were not retrieved", { companyId, retrieved: bulk.rows.length });
      }
      // A bulk pull legitimately returns visits for inspections outside our
      // discovery set (closed/cancelled work). Filtering them out is expected
      // here and is NOT an error — unlike the fan-out path below, where a
      // foreign row would mean the server ignored inspection_id.
      rawVisits = bulk.rows.filter((v) => v.inspection_id != null && discoveredIds.has(v.inspection_id));
      logger.info("inspectpoint sync: bulk visit pull", {
        companyId, fetched: bulk.rows.length, keptForDiscoveredInspections: rawVisits.length,
      });

      // Top-up for offset-pagination skew. Paging a live table by offset both
      // repeats and SKIPS rows as data shifts underneath — the duplicates are
      // visible (2,599 rows for 2,596 ids) and the omissions are not. Observed
      // for real: one inspection out of 1,533 came back with no visit from the
      // bulk pull while /inspection_visits?inspection_id= returned one
      // immediately.
      //
      // That gap is not cosmetic: a job with no appointment is exactly what
      // processOpenJobDueSoon looks for, so a dropped visit turns into a
      // spurious "let's get this scheduled" call about work that is already
      // scheduled. Re-fetching just the misses is precise and costs ~1 request.
      // Capped so a tenant whose inspections genuinely have no visits can't
      // turn this into a second full fan-out.
      const covered = new Set(rawVisits.map((v) => v.inspection_id));
      const missing = inspections.rows.filter((i) => !covered.has(i.id));
      if (missing.length) {
        const topUp = missing.slice(0, VISIT_TOPUP_CAP);
        logger.warn("inspectpoint sync: inspections had no visit in the bulk pull — re-fetching them individually", {
          companyId, missing: missing.length, toppingUp: topUp.length,
          capped: missing.length > VISIT_TOPUP_CAP,
        });
        if (missing.length > VISIT_TOPUP_CAP) visitsComplete = false;
        const topUpFetches = await mapWithConcurrency(topUp, VISIT_CONCURRENCY, (inspection) =>
          ip.fetchAllPages(companyId, "/external/api/v2/inspection_visits", { inspection_id: inspection.id }, credentials, (d) => d)
        );
        for (const f of topUpFetches) {
          if (!f.complete) visitsComplete = false;
          rawVisits.push(...f.rows.filter((v) => v.inspection_id != null && discoveredIds.has(v.inspection_id)));
        }
      }
    } else {
      const visitFetches = await mapWithConcurrency(inspections.rows, VISIT_CONCURRENCY, (inspection) =>
        ip.fetchAllPages(companyId, "/external/api/v2/inspection_visits", { inspection_id: inspection.id }, credentials, (d) => d)
      );
      for (const f of visitFetches) {
        if (!f.complete) visitsComplete = false;
        rawVisits.push(...f.rows);
      }
      // Here a foreign row DOES mean the server ignored inspection_id, which
      // would silently attach one inspection's visits to another's job.
      const foreign = rawVisits.filter((v) => v.inspection_id != null && !discoveredIds.has(v.inspection_id));
      if (foreign.length) {
        visitsComplete = false;
        logger.error("inspectpoint sync: visits returned for inspections we did not request — the inspection_id filter was ignored server-side; dropping them, appointments would otherwise be attached to the wrong job", {
          companyId, count: foreign.length, sampleVisitIds: foreign.slice(0, 5).map((v) => v.id),
        });
        rawVisits = rawVisits.filter((v) => v.inspection_id == null || discoveredIds.has(v.inspection_id));
      }
    }

    // Dedupe by visit id before counting or upserting. Offset pagination can
    // return the same row on two pages, and the top-up above can re-fetch one
    // the bulk pass also had — upsertRawBatch guards the write, but
    // counts.appointments is read straight off this array and would otherwise
    // over-report.
    const uniqueVisits = [...new Map(rawVisits.filter((v) => v?.id != null).map((v) => [v.id, v])).values()];
    const visits = validateIds(uniqueVisits, "/v2/inspection_visits");
    if (!visits.complete) visitsComplete = false;

    // The inspection carries its own scheduled_time_iso and each visit carries
    // its own scheduled_date. They agree on every row of the live tenant, but
    // the VISIT is the authoritative one for confirmation purposes (it is what
    // becomes appointments.scheduled_start) — so divergence is worth surfacing
    // rather than silently preferring one.
    const inspectionDateById = new Map(inspections.rows.map((i) => [i.id, (i.scheduled_time_iso || "").slice(0, 10)]));
    const diverged = visits.rows.filter((v) => {
      const inspDate = inspectionDateById.get(v.inspection_id);
      const visitDate = (v.scheduled_date || "").slice(0, 10);
      return inspDate && visitDate && inspDate !== visitDate;
    });
    if (diverged.length) {
      logger.warn("inspectpoint sync: visit scheduled_date differs from its inspection's scheduled_time_iso — the VISIT wins (it is what the customer is confirming)", {
        companyId, count: diverged.length,
        sample: diverged.slice(0, 3).map((v) => ({ visitId: v.id, inspectionId: v.inspection_id, visit: (v.scheduled_date || "").slice(0, 10), inspection: inspectionDateById.get(v.inspection_id) })),
      });
    }
    await syncDb.upsertRawBatch(
      "inspectpoint_appointments",
      ["inspectpoint_job_id", "inspectpoint_technician_id", "visit_status", "scheduled_date"],
      companyId, visits.rows.map(mapVisitRow)
    );
    counts.appointments = visits.rows.length;
    if (engine) await engine.emit("fetched", { entity: "inspection_visits", count: counts.appointments });

    const incomplete = Object.entries(complete).filter(([, ok]) => !ok).map(([entity]) => entity);
    await syncDb.updateSyncState(companyId, {
      last_sync_at: runStartedAt.toISOString(),
      last_full_sync_at: isFull ? runStartedAt.toISOString() : undefined,
      last_sync_status: incomplete.length ? "partial" : "success",
      last_sync_error: incomplete.length ? `Incomplete entities (cursor not advanced): ${incomplete.join(", ")}` : null,
      // Only advance a cursor when that entity's own fetch came back complete.
      // accounts/buildings are fetched independently of the inspections
      // window (their own paginated endpoint, own updated_at_start cursor),
      // so a jobs-only customWindow request doesn't affect them.
      last_customers_updated_at: complete.customers ? runStartedAt.toISOString() : undefined,
      last_locations_updated_at: complete.locations ? runStartedAt.toISOString() : undefined,
      // A custom window only covers the caller's date range, not the whole
      // open-work universe — advancing this to "now" would make the NEXT
      // regular incremental run's updated_at_start filter start from here,
      // silently skipping whatever changed between the OLD cursor and now
      // outside the backfilled window. See servicetrade-sync.js's own
      // customWindow handling for the same reasoning.
      last_jobs_updated_at: (customWindow || !complete.jobs) ? undefined : runStartedAt.toISOString(),
      // Informational only — these three have no real cursor to advance.
      last_contacts_synced_at: runStartedAt.toISOString(),
      last_technicians_synced_at: runStartedAt.toISOString(),
      last_appointments_synced_at: visitsComplete ? runStartedAt.toISOString() : undefined,
    });

    if (incomplete.length) {
      logger.warn("inspectpoint runSync: partial run, will retry these entities next tick", { companyId, incomplete, counts });
    } else {
      logger.info("inspectpoint runSync done", { companyId, counts, customWindow });
    }
    return { success: true, counts, incomplete, ...(customWindow ? { customWindow: true } : {}) };
  } catch (err) {
    logger.error("inspectpoint runSync failed", { companyId, error: err.message });
    await syncDb
      .updateSyncState(companyId, { last_sync_status: "failed", last_sync_error: String(err.message).slice(0, 1000) })
      .catch(() => {});
    return { success: false, error: err.message, counts };
  }
}

module.exports = { runSync };
