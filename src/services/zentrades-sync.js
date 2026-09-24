/**
 * ZenTrades raw sync engine.
 *
 * Structurally different from both other CRMs: ServiceTrade and InspectPoint
 * each fetch N independent endpoints -> N entities, so `complete`/cursors
 * are per-entity and genuinely independent. ZenTrades has ONE fat ticket
 * search endpoint whose every hit embeds its customer, service address
 * (+ additionalContacts), assignments, and each assignment's technician —
 * six entities decomposed from one fetch, not six independent ones. There is
 * exactly ONE completeness signal for those six streams (`complete.tickets`)
 * plus one independent signal for the conditional recurrence fan-out
 * (`complete.recurrences`) — never fake a third.
 *
 * Whether ZenTrades' list filter accepts an `updatedAt` term at all (a real
 * incremental cursor) is UNRESOLVED — nothing here assumes one exists. This
 * is a WINDOW-first design: every run (incremental or full) re-pulls a
 * rolling schedule window in full, wider on `full=true`. A real cursor, if
 * confirmed later, is a pure ADDITION (a second pass unioned into the same
 * dedupe) — see migrations/108_zentrades_raw_tables.sql's header for why
 * `zentrades_sync_state` ships with no `_updated_at` column yet.
 */

const zentrades = require("./zentrades");
const credsDb = require("../db/zentrades-credentials");
const syncDb = require("../db/zentrades-sync");
const todosDb = require("../db/todos");
const { mapWithConcurrency } = require("../utils/concurrency");
const logger = require("../utils/logger");

const TICKET_SEARCH_PATH = "/api/ticket/search/filtered";
const TICKET_DETAIL_PATH = "/api/ticket";

const WINDOW_DAYS_BACK = 7;
const WINDOW_DAYS_FORWARD = 60;
const FULL_WINDOW_DAYS_BACK = 90;
const FULL_WINDOW_DAYS_FORWARD = 365;
const SLICE_DAYS = 7;
const SLICE_CONCURRENCY = 4;
const RECURRENCE_CONCURRENCY = 8;
const RECURRENCE_FANOUT_CAP = 500;

// `jobStatusId` is PER-TENANT configuration, not a global ZenTrades enum —
// confirmed live 2026-09-10: company 12 (the sandbox tenant, zentradesCompanyId
// 3) uses jobStatusId 1 for "Open", but company 13 (Element Fire, a real
// production tenant, zentradesCompanyId 974) uses 1988 for the exact same
// "Open" label. This used to be hardcoded to 1 as a server-side search term,
// which silently matched zero of company 13's tickets — a fully successful,
// zero-error sync that fetched nothing, for every run since that company
// connected. Matched on the STRING label instead (`jobStatus`, present on
// every hit alongside its tenant-specific numeric id), which is
// tenant-portable; never reintroduce a hardcoded numeric jobStatusId.
const OPEN_JOB_STATUS_LABEL = "open";

// ── Window slicing ────────────────────────────────────────────────────────
//
// ZenTrades' list filter (gteDate/ltDate) is an OVERLAP test
// (end >= X AND start < Y), not a containment test — slicing the resolved
// window into contiguous sub-intervals therefore cannot lose a
// boundary-straddling ticket (it returns in both adjacent slices; dedupe
// handles it) and, more importantly, makes offset pagination mostly
// disappear: at PER_PAGE=200 (see services/zentrades.js), a tenant with
// fewer than 200 open tickets in any given week never paginates a single
// slice at all — the instability that bit InspectPoint (2,599 rows for
// 2,596 distinct ids, PLUS invisible omissions) is structurally absent for
// most tenants, not just mitigated.

function sliceWindow(from, to, sliceDays = SLICE_DAYS) {
  const sliceMs = sliceDays * 86400000;
  const end = to.getTime();
  let cursor = from.getTime();
  if (cursor >= end) return [{ from: new Date(cursor), to: new Date(end) }];
  const slices = [];
  while (cursor < end) {
    const sliceEnd = Math.min(cursor + sliceMs, end);
    slices.push({ from: new Date(cursor), to: new Date(sliceEnd) });
    cursor = sliceEnd;
  }
  return slices;
}

/**
 * Fetch one date slice of open tickets, reconciled against the envelope's
 * own `count` — an oracle InspectPoint never had. A slice returning fewer
 * DISTINCT ids than its own reported count means pagination silently
 * omitted rows (the exact failure mode that was invisible on InspectPoint);
 * more than `count` just means the table grew mid-walk, which is benign.
 *
 * No `sortBy` — VERIFIED LIVE: the API rejects the param outright
 * (`"sortBy" is not allowed`, code E100). There is therefore no stable sort
 * order to lean on for pagination safety; this relies entirely on window
 * slicing (small slices rarely paginate at all) plus the count reconciliation
 * right below, exactly the fallback this design was already built around.
 */
async function fetchTicketSlice(companyId, { from, to }) {
  // No jobStatusId term — see OPEN_JOB_STATUS_LABEL's comment: the numeric id
  // is per-tenant, so a server-side filter on it can't be written correctly
  // without already knowing this specific tenant's mapping. Status filtering
  // happens client-side below, on the tenant-portable string label instead.
  const body = {
    gteDate: [{ scheduledEndTime: from.toISOString() }],
    ltDate: [{ scheduledStartTime: to.toISOString() }],
    businessUnitIds: [],
    terms: [],
  };
  const result = await zentrades.fetchAllPages(companyId, TICKET_SEARCH_PATH, body);
  const distinctIds = new Set(result.rows.map((r) => r?.id).filter((id) => id != null));

  // Diagnostic trail for exactly the class of bug the switch to a string
  // label just fixed — if a tenant's "open" label is spelled differently
  // than expected, this makes that visible immediately instead of silently
  // fetching zero rows again.
  const statusCounts = {};
  for (const hit of result.rows) {
    const label = String(hit?.jobStatus ?? "").trim().toLowerCase() || "(none)";
    statusCounts[label] = (statusCounts[label] || 0) + 1;
  }
  logger.debug("zentrades sync: ticket slice status distribution", {
    companyId, from: from.toISOString(), to: to.toISOString(), totalHits: result.rows.length, statusCounts,
  });

  let complete = result.complete;
  if (result.count != null && distinctIds.size < result.count) {
    logger.error("zentrades sync: slice returned fewer distinct tickets than the server's own count — pagination likely omitted rows", {
      companyId, from: from.toISOString(), to: to.toISOString(), distinct: distinctIds.size, count: result.count,
    });
    complete = false;
  }
  return { hits: result.rows, complete };
}

// ── Cross-fetch dedupe ────────────────────────────────────────────────────
//
// Two tickets fetched in the SAME run (adjacent slices, or the same ticket
// embedded via a customer/location shared across many tickets) can carry two
// snapshots taken at different times — last-write-wins by iteration order is
// unsafe, exactly as it was for InspectPoint's status-fan-out union. Prefer
// the object with the newer updatedAt; keep the incumbent on a tie.
function keepFreshest(map, key, obj, updatedAtOf = (o) => o.updatedAt) {
  const existing = map.get(key);
  if (!existing || new Date(updatedAtOf(obj) || 0) >= new Date(updatedAtOf(existing) || 0)) {
    map.set(key, obj);
  }
}

// ── Row mappers: ZenTrades API object -> zentrades_* raw row ────────────────

function normalizeEmail(email) {
  return email ? String(email).trim().toLowerCase() : null;
}

/** A projected person object, NOT the whole parent — see migrations/108's contacts section. */
function projectPerson(obj) {
  return {
    firstname: obj.firstname ?? null,
    lastname: obj.lastname ?? null,
    name: obj.name ?? null,
    additionalName: obj.additionalName ?? null,
    displayName: obj.displayName ?? null,
    email: obj.email ?? null,
    cellphone: obj.cellphone ?? null,
    landline: obj.landline ?? null,
    ext: obj.ext ?? null,
  };
}

function mapTicketRow(hit) {
  return {
    zentradesId: hit.id,
    zentrades_customer_id: hit.customerId ?? null,
    zentrades_location_id: hit.serviceAddressId ?? null,
    job_status_id: hit.jobStatusId ?? null,
    job_status: hit.jobStatus ?? null,
    scheduled_start: hit.scheduledStartTime ?? null,
    scheduled_end: hit.scheduledEndTime ?? null,
    ticket_number: hit.ticketNumber ?? null,
    combined_feature_flag: hit.combinedFeatureFlag ?? null,
    is_active: hit.isActive !== false && hit.isDeleted !== true,
    payload: hit,
    ztUpdatedAt: hit.updatedAt ?? null,
  };
}

/** scheduled_start/end come from the ASSIGNMENT, never the parent ticket — the dispatch record is what's actually being confirmed. */
function mapAppointmentRow(assignment, ticketId) {
  return {
    zentradesId: assignment.id,
    zentrades_ticket_id: ticketId,
    zentrades_technician_id: assignment.technicianId ?? null,
    assignment_status_id: assignment.assignmentStatusId ?? null,
    assignment_status: assignment.status ?? null,
    assignment_status_cf_id: assignment.assignmentStatusCFId ?? null,
    assignment_status_cf: assignment.statusCF ?? null,
    scheduled_start: assignment.startTime ?? null,
    scheduled_end: assignment.endTime ?? null,
    recurring_assignment_id: assignment.recurringAssignmentId ?? null,
    is_active: assignment.isActive !== false && assignment.isDeleted !== true,
    payload: assignment,
    ztUpdatedAt: assignment.updatedAt ?? null,
  };
}

/** billingAddress is stripped — product decision is service-address-only; see migrations/108's header. */
function mapCustomerRow(customer) {
  const { billingAddress, ...rest } = customer;
  return {
    zentradesId: customer.id,
    is_active: customer.isActive !== false && customer.isDeleted !== true,
    payload: rest,
    ztUpdatedAt: customer.updatedAt ?? null,
  };
}

function mapLocationRow(serviceAddress) {
  return {
    zentradesId: serviceAddress.id,
    zentrades_customer_id: serviceAddress.customerId ?? null,
    do_not_serve: serviceAddress.doNotServe === true,
    is_active: serviceAddress.isActive !== false && serviceAddress.isDeleted !== true,
    payload: serviceAddress,
    ztUpdatedAt: serviceAddress.updatedAt ?? null,
  };
}

function mapTechnicianRow(technician) {
  return {
    zentradesId: technician.id,
    is_active: technician.isActive !== false && technician.isDeleted !== true,
    payload: technician,
    ztUpdatedAt: technician.updatedAt ?? null,
  };
}

/**
 * Dispatches on the three synthetic contact "kinds" — see
 * migrations/108_zentrades_raw_tables.sql's contacts section for why
 * customer/serviceAddress/additionalContact each need their own id
 * namespace (cust:/addr:/ac:).
 */
function mapContactRow({ kind, data, parent }) {
  if (kind === "customer") {
    return {
      zentradesId: `cust:${data.id}`,
      contact_kind: "customer",
      zentrades_customer_id: data.id,
      zentrades_location_id: null,
      email_lower: normalizeEmail(data.email),
      is_active: data.isActive !== false && data.isDeleted !== true,
      payload: projectPerson(data),
      ztUpdatedAt: data.updatedAt ?? null,
    };
  }
  if (kind === "service_address") {
    return {
      zentradesId: `addr:${data.id}`,
      contact_kind: "service_address",
      zentrades_customer_id: data.customerId ?? null,
      zentrades_location_id: data.id,
      email_lower: normalizeEmail(data.email),
      is_active: data.isActive !== false && data.isDeleted !== true,
      payload: projectPerson(data),
      ztUpdatedAt: data.updatedAt ?? null,
    };
  }
  // 'additional' — an additionalContacts[] entry, scoped to its parent address
  return {
    zentradesId: `ac:${data.id}`,
    contact_kind: "additional",
    zentrades_customer_id: parent?.customerId ?? null,
    zentrades_location_id: parent?.id ?? null,
    email_lower: normalizeEmail(data.email),
    is_active: data.isActive !== false && data.isDeleted !== true,
    payload: { name: data.name ?? null, email: data.email ?? null, landline: data.landline ?? null, cellphone: data.cellphone ?? null, ext: data.ext ?? null },
    ztUpdatedAt: data.updatedAt ?? null,
  };
}

function mapRecurrenceRow(rruleDetails, ticketId, ticketUpdatedAt) {
  return {
    zentradesId: rruleDetails.id ?? null,
    zentrades_ticket_id: ticketId,
    rrule: rruleDetails.rrule ?? null,
    rrule_string: rruleDetails.rruleString ?? null,
    nth_event: rruleDetails.nthEvent ?? null,
    module_id: rruleDetails.moduleId ?? null,
    zt_ticket_updated_at: ticketUpdatedAt,
    is_active: rruleDetails.isDeleted !== true,
    payload: rruleDetails,
    ztUpdatedAt: rruleDetails.updatedAt ?? null,
  };
}

/**
 * Conditional recurrence fan-out. Trigger: non-empty combinedFeatureFlag
 * (product decision: presence = recurring). The skip-cache is the whole
 * trick AND what prevents starvation: a naive cap + soonest-first would
 * starve the tail forever since there's no cursor, but skipping tickets
 * whose zt_ticket_updated_at hasn't changed reduces steady-state cost to
 * newly-created-or-edited recurring tickets only, so the cap almost never
 * binds in practice.
 */
async function fetchRecurrences(companyId, tickets) {
  const candidates = tickets.filter((t) => t.combinedFeatureFlag);
  if (candidates.length === 0) return { rows: [], complete: true };

  const cache = await syncDb.getRecurrenceFanoutCache(companyId);
  const toFetch = candidates.filter((t) => {
    const cached = cache.get(String(t.id));
    if (!cached) return true;
    return new Date(cached).getTime() !== new Date(t.updatedAt || 0).getTime();
  });

  const sorted = [...toFetch].sort((a, b) => new Date(a.scheduledStartTime || 0) - new Date(b.scheduledStartTime || 0));
  let capped = false;
  let workList = sorted;
  if (sorted.length > RECURRENCE_FANOUT_CAP) {
    capped = true;
    workList = sorted.slice(0, RECURRENCE_FANOUT_CAP);
    logger.warn("zentrades sync: recurrence fan-out capped — remainder covered next run", { companyId, candidates: sorted.length, cap: RECURRENCE_FANOUT_CAP });
  }

  let missingDetailCount = 0;
  const results = await mapWithConcurrency(workList, RECURRENCE_CONCURRENCY, async (ticket) => {
    const res = await zentrades.request(companyId, "GET", TICKET_DETAIL_PATH, { query: { id: ticket.id }, retryable: true });
    if (!res.ok) {
      logger.warn("zentrades sync: recurrence detail fetch failed", { companyId, ticketId: ticket.id, status: res.status });
      return { ok: false };
    }
    const detail = res.data || {};
    // Foreign-row guard — the same class of check InspectPoint needed when a
    // filter was ignored server-side: never trust that a keyed request
    // actually returned the row it asked for.
    if (detail.id != null && String(detail.id) !== String(ticket.id)) {
      logger.error("zentrades sync: ticket detail returned a different ticket than requested — dropping", { companyId, requested: ticket.id, got: detail.id });
      return { ok: false };
    }
    const rrule = detail.rruleDetails;
    if (!rrule) {
      // Flag present but no rruleDetails — NOT an error. A rising count here
      // is the signal that "flag present ⇒ recurring" needs revisiting.
      missingDetailCount++;
      return { ok: true, row: null };
    }
    if (rrule.moduleEntityId != null && String(rrule.moduleEntityId) !== String(ticket.id)) {
      // Same class of problem as the detail.id check above (the server
      // handed back data for the wrong ticket) — mark incomplete too, not
      // just the benign "no rruleDetails at all" case below.
      logger.error("zentrades sync: rruleDetails.moduleEntityId does not match the requested ticket — dropping, marking incomplete", { companyId, requested: ticket.id, moduleEntityId: rrule.moduleEntityId });
      return { ok: false };
    }
    return { ok: true, row: mapRecurrenceRow(rrule, ticket.id, ticket.updatedAt ?? null) };
  });

  if (missingDetailCount > 0) {
    logger.warn("zentrades sync: some flagged tickets had no rruleDetails on their detail fetch", { companyId, missingDetailCount });
  }

  return {
    rows: results.filter((r) => r?.ok && r.row).map((r) => r.row),
    complete: !capped && results.every((r) => r?.ok !== false),
  };
}

/**
 * @param {string|number} companyId
 * @param {{full?: boolean, engine?: object|null, scheduleDateFrom?: number|null, scheduleDateTo?: number|null}} [opts]
 *   scheduleDateFrom/scheduleDateTo are unix SECONDS — same param names/units
 *   engines/crm-sync already passes to every provider. Presence of either
 *   (not length/truthiness quirks — just != null) makes this a CUSTOM RANGE
 *   run: it replaces the whole rolling window rather than narrowing it, and
 *   deliberately does not advance any sync-state stamp (see the `stamp`
 *   computation below), so it's safe to run repeatedly without disturbing
 *   normal incremental syncs.
 */
async function runSync(companyId, { full = false, engine = null, scheduleDateFrom = null, scheduleDateTo = null } = {}) {
  const credState = await credsDb.getByCompanyId(companyId);
  if (!credState) return { success: false, error: "ZenTrades not connected" };
  if (credState.authStatus !== "ok") {
    // Skip the sync attempt entirely rather than let it discover this via a
    // failed login mid-run — see services/zentrades.js's getAccessToken for
    // why hammering a known-bad password every cron tick is actively harmful.
    return { success: false, error: `ZenTrades re-authentication required (${credState.authStatus})` };
  }
  const tenantCompanyId = credState.metadata?.zentradesCompanyId ?? null;

  const customWindow = scheduleDateFrom != null || scheduleDateTo != null;
  let from;
  let to;
  if (customWindow) {
    from = new Date(scheduleDateFrom * 1000);
    to = new Date(scheduleDateTo * 1000);
  } else if (full) {
    // "Full" here means WIDEST WINDOW, not "drop a cursor" the way it does
    // for the other two CRMs — ZenTrades' filter requires a date window on
    // every request, so there's no unbounded mode to drop into.
    from = new Date(Date.now() - FULL_WINDOW_DAYS_BACK * 86400000);
    to = new Date(Date.now() + FULL_WINDOW_DAYS_FORWARD * 86400000);
  } else {
    from = new Date(Date.now() - WINDOW_DAYS_BACK * 86400000);
    to = new Date(Date.now() + WINDOW_DAYS_FORWARD * 86400000);
  }
  const runStartedAt = new Date();

  logger.info("zentrades sync starting", {
    companyId, mode: full ? "full" : customWindow ? "custom" : "window",
    from: from.toISOString(), to: to.toISOString(),
  });

  const counts = { tickets: 0, appointments: 0, customers: 0, locations: 0, technicians: 0, contacts: 0, recurrences: 0 };

  try {
    if (engine) await engine.transition("fetching_tickets", {});
    const slices = sliceWindow(from, to);
    const sliceResults = await mapWithConcurrency(slices, SLICE_CONCURRENCY, (slice) => fetchTicketSlice(companyId, slice));
    if (engine) await engine.emit("fetched", { entity: "tickets", count: sliceResults.reduce((n, r) => n + r.hits.length, 0) });

    const ticketsById = new Map();
    for (const sr of sliceResults) {
      for (const hit of sr.hits) {
        if (hit?.id == null) continue;
        keepFreshest(ticketsById, hit.id, hit);
      }
    }

    // ── Client-side re-verification — never trust a server-side filter
    // blindly, especially an undocumented one. Status mismatch and window
    // mismatch are filtered but do NOT mark the run incomplete (the result
    // is still correct, just costlier); a tenant mismatch DOES, since it
    // means credentials/scoping are wrong, not just a loose filter. ────────
    //
    // Status is now filtered by fetchTicketSlice's own client-side pass too
    // (no server-side term at all — see OPEN_JOB_STATUS_LABEL), so this loop
    // is the SOLE place "which tickets are actually Open" gets decided.
    // Matched on the string label, never the numeric jobStatusId — that id is
    // per-tenant configuration (verified live: 1 for company 12's sandbox
    // tenant, 1988 for company 13's real one), so comparing it against any
    // hardcoded constant silently drops every ticket for a tenant whose id
    // differs, exactly as it did for company 13 until this fix.
    let tenantMismatchDetected = false;
    const validTickets = [];
    for (const hit of ticketsById.values()) {
      const statusLabel = String(hit.jobStatus ?? "").trim().toLowerCase();
      if (statusLabel !== OPEN_JOB_STATUS_LABEL) {
        continue;
      }
      const start = hit.scheduledStartTime ? new Date(hit.scheduledStartTime) : null;
      const end = hit.scheduledEndTime ? new Date(hit.scheduledEndTime) : null;
      const inWindow = !!(end && start && end >= from && start < to);
      if (!inWindow) {
        logger.warn("zentrades sync: dropping a ticket outside the requested schedule window", { companyId, ticketId: hit.id, scheduledStartTime: hit.scheduledStartTime, scheduledEndTime: hit.scheduledEndTime });
        continue;
      }
      if (tenantCompanyId != null && hit.companyId != null && Number(hit.companyId) !== Number(tenantCompanyId)) {
        logger.error("zentrades sync: a ticket's companyId does not match this integration's tenant — dropping, marking incomplete", { companyId, ticketId: hit.id, hitCompanyId: hit.companyId, expected: tenantCompanyId });
        tenantMismatchDetected = true;
        continue;
      }
      validTickets.push(hit);
    }

    // ── Decomposition — one pass, six sinks ────────────────────────────────
    const customers = new Map();
    const locations = new Map();
    const technicians = new Map();
    const contacts = new Map();
    const ticketRows = [];
    const appointmentRows = [];
    let thinHitCount = 0;

    for (const hit of validTickets) {
      ticketRows.push(mapTicketRow(hit));

      for (const a of (Array.isArray(hit.assignments) ? hit.assignments : [])) {
        if (a?.id == null) continue;
        appointmentRows.push(mapAppointmentRow(a, hit.id));
        if (a.technician?.id != null) keepFreshest(technicians, a.technician.id, a.technician);
      }

      if (hit.serviceAddress?.id != null) {
        keepFreshest(locations, hit.serviceAddress.id, hit.serviceAddress);
        keepFreshest(contacts, `addr:${hit.serviceAddress.id}`, { kind: "service_address", data: hit.serviceAddress, parent: null }, (o) => o.data.updatedAt);
        for (const ac of (hit.serviceAddress.additionalContacts || [])) {
          if (ac?.id == null) continue;
          keepFreshest(contacts, `ac:${ac.id}`, { kind: "additional", data: ac, parent: hit.serviceAddress }, (o) => o.data.updatedAt);
        }
      } else {
        thinHitCount++;
      }

      if (hit.customer?.id != null) {
        keepFreshest(customers, hit.customer.id, hit.customer);
        keepFreshest(contacts, `cust:${hit.customer.id}`, { kind: "customer", data: hit.customer, parent: null }, (o) => o.data.updatedAt);
      } else {
        thinHitCount++;
      }
    }
    if (thinHitCount > 0) {
      logger.warn("zentrades sync: some tickets were missing customer/serviceAddress — thin data, not a fetch error", { companyId, thinHitCount });
    }

    if (engine) await engine.transition("fetching_recurrences", {});
    const recurrenceResult = await fetchRecurrences(companyId, validTickets);

    // ── Upserts — FK-friendly order (soft FKs, not DB-enforced) ────────────
    counts.customers = await syncDb.upsertRawBatch("zentrades_customers", [], companyId, [...customers.values()].map(mapCustomerRow));
    counts.locations = await syncDb.upsertRawBatch("zentrades_locations", ["zentrades_customer_id", "do_not_serve"], companyId, [...locations.values()].map(mapLocationRow));
    counts.technicians = await syncDb.upsertRawBatch("zentrades_technicians", [], companyId, [...technicians.values()].map(mapTechnicianRow));
    counts.contacts = await syncDb.upsertRawBatch(
      "zentrades_contacts", ["contact_kind", "zentrades_customer_id", "zentrades_location_id", "email_lower"],
      companyId, [...contacts.values()].map(mapContactRow)
    );
    counts.tickets = await syncDb.upsertRawBatch(
      "zentrades_tickets",
      ["zentrades_customer_id", "zentrades_location_id", "job_status_id", "job_status", "scheduled_start", "scheduled_end", "ticket_number", "combined_feature_flag"],
      companyId, ticketRows
    );
    counts.appointments = await syncDb.upsertRawBatch(
      "zentrades_appointments",
      ["zentrades_ticket_id", "zentrades_technician_id", "assignment_status_id", "assignment_status", "assignment_status_cf_id", "assignment_status_cf", "scheduled_start", "scheduled_end", "recurring_assignment_id"],
      companyId, appointmentRows
    );
    counts.recurrences = await syncDb.upsertRawBatch(
      "zentrades_recurrences", ["zentrades_ticket_id", "rrule", "rrule_string", "nth_event", "module_id", "zt_ticket_updated_at"],
      companyId, recurrenceResult.rows, { conflictColumns: ["company_id", "zentrades_ticket_id"] }
    );
    if (engine) await engine.emit("entity_done", { entity: "tickets", count: counts.tickets });

    const ticketsComplete = sliceResults.every((r) => r.complete) && !tenantMismatchDetected;

    // ── Absence warning — never infer a terminal status from absence.
    // Skipped for a custom window (its scope is the caller's date range, not
    // "everything currently open", so a ticket outside it is expected to be
    // missing). Three indistinguishable causes here, not two like
    // InspectPoint: schedule moved, status changed upstream, or pagination
    // skew — a rescheduled ticket and a completed one look identical. The
    // one signal we DO act on is an explicit isDeleted/isActive:false on a
    // RETURNED row, handled by the mappers' is_active field above. ─────────
    if (!customWindow && ticketsComplete) {
      const locallyOpen = await syncDb.listOpenTicketIdsInWindow(companyId, from, to).catch(() => []);
      const returned = new Set(validTickets.map((t) => String(t.id)));
      const vanished = locallyOpen.filter((id) => !returned.has(id));
      if (vanished.length) {
        logger.warn("zentrades sync: some locally-open tickets in this window were not returned by a complete pull — not inferring a status change", {
          companyId, count: vanished.length, sample: vanished.slice(0, 10),
        });
      }
    }

    const complete = { tickets: ticketsComplete, recurrences: recurrenceResult.complete };
    const incomplete = Object.entries(complete).filter(([, ok]) => !ok).map(([k]) => k);

    // Six stamps, ONE flag — see zentrades_sync_state's header. A custom
    // window never advances any stamp (its scope is the caller's date range,
    // not "the whole regular window"), same reasoning as the other two CRMs'
    // custom-range handling.
    const stamp = complete.tickets && !customWindow ? runStartedAt.toISOString() : undefined;
    await syncDb.updateSyncState(companyId, {
      last_sync_at: runStartedAt.toISOString(),
      last_full_sync_at: full ? runStartedAt.toISOString() : undefined,
      last_sync_status: incomplete.length ? "partial" : "success",
      last_sync_error: incomplete.length ? `Incomplete: ${incomplete.join(", ")}` : null,
      last_tickets_synced_at: stamp,
      last_customers_synced_at: stamp,
      last_locations_synced_at: stamp,
      last_contacts_synced_at: stamp,
      last_technicians_synced_at: stamp,
      last_appointments_synced_at: stamp,
      last_recurrences_synced_at: complete.recurrences && !customWindow ? runStartedAt.toISOString() : undefined,
      // No sort order is requested (the API rejects `sortBy` outright) — this
      // records that fact for observability, not a real pagination strategy.
      last_pagination_mode: "unsorted",
    }).catch((err) => logger.warn("zentrades sync: failed to update sync state", { companyId, error: err.message }));

    // A clean run means every ZenTrades call that ran this time succeeded —
    // clear any stale "this endpoint was failing" Action Item left over from
    // an earlier run rather than let it linger after the problem cleared on
    // its own. Deliberately gated on the WHOLE run being clean, not just
    // "no error this specific request" — a single resolve call here is
    // cheap; resolving per-request would be needless DB traffic.
    if (incomplete.length === 0) {
      await todosDb.resolveCrmApiErrorTodos({ companyId, source: "zentrades" }).catch(() => {});
    }

    logger.info("zentrades sync done", { companyId, counts, incomplete });
    return { success: true, counts, incomplete, ...(customWindow ? { customWindow: true } : {}) };
  } catch (err) {
    logger.error("zentrades sync error", { companyId, error: err.message });
    await syncDb.updateSyncState(companyId, {
      last_sync_status: "failed",
      last_sync_error: String(err.message || "ZenTrades sync failed").slice(0, 1000),
    }).catch(() => {});
    return { success: false, error: err.message, counts };
  }
}

module.exports = {
  runSync,
  sliceWindow,
  keepFreshest,
  mapTicketRow,
  mapAppointmentRow,
  mapCustomerRow,
  mapLocationRow,
  mapTechnicianRow,
  mapContactRow,
  mapRecurrenceRow,
};
