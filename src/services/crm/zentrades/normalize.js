/**
 * zentrades_* raw rows -> platform tables (customers/locations/contacts/
 * technicians/jobs/appointments), source='zentrades'.
 *
 * Caller is responsible for resolving every FK id (customerId, locationId,
 * technicianId, primaryContactId) via its own external_ref lookup before
 * calling these — same convention as crm/servicetrade/normalize.js and
 * crm/inspectpoint/normalize.js.
 *
 * Structurally closest to InspectPoint's normalize module (slim raw rows,
 * one entity's `payload` sometimes needs to reach into another for context)
 * but with one problem InspectPoint never had: ZenTrades has no single
 * "contact" entity at all. A person can appear as the ticket's `customer`,
 * the `serviceAddress`'s own person fields, or an `additionalContacts[]`
 * entry — three raw rows for what may be one real person. dedupeContactsByEmail
 * below merges those by lowercased email before anything becomes a platform
 * `contacts` row, mirroring crm/servicetrade/provider.js's
 * dedupeContactsByEmail (same problem, ServiceTrade's is by CRM contact id
 * instead of by synthetic kind).
 */

const { toE164 } = require("../../../utils/phone");

const SOURCE = "zentrades";

// `jobStatusId` is per-tenant configuration, not a stable ZenTrades-wide enum
// — verified live 2026-09-10: company 12's sandbox tenant uses 1 for "Open",
// company 13's real one (Element Fire) uses 1988. services/zentrades-sync.js
// only ever stores tickets whose STRING label is "Open" (see its own
// OPEN_JOB_STATUS_LABEL comment), so match on that same label here too —
// comparing against any hardcoded numeric id silently mis-derives status for
// every tenant whose id isn't exactly that constant (this previously fell
// into the "unmapped" branch below for company 13's tickets, which skips the
// live-assignment check entirely — misclassifying a ticket with an actually-
// dispatched technician as unscheduled, precisely what this function exists
// to avoid).
const OPEN_JOB_STATUS_LABEL = "open";

/**
 * One `name` string -> {firstName, lastName}. Only needed for
 * additionalContacts entries, which carry a single `name` field and nothing
 * split — customer/serviceAddress rows have real firstname/lastname fields
 * and never go through this. Deliberately conservative, same reasoning as
 * crm/inspectpoint/normalize.js's splitPersonName: no title/suffix
 * heuristics, just "everything but the last token is the first name".
 */
function splitPersonName(name) {
  if (!name) return { firstName: null, lastName: null };
  const s = String(name).trim().replace(/\s+/g, " ");
  if (!s) return { firstName: null, lastName: null };
  const parts = s.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

/**
 * The `YYYY-MM-DD` UTC prefix of a raw TIMESTAMPTZ column's value.
 *
 * Deliberately NOT `String(value).slice(0, 10)` — node-postgres returns a
 * TIMESTAMPTZ column as a native JS `Date` object, not an ISO string,
 * so `String(dateObject)` calls `Date.prototype.toString()` and produces
 * something like `"Sun Sep 13 2026 07:00:00 GMT-0400 ..."` — whose first 10
 * characters are `"Sun Sep 13"`, not a date. This bit live: an INSERT into
 * `jobs.scheduled_date` (a DATE column) failed with exactly that string.
 * `new Date(value)` accepts a Date object, an ISO string, or anything else
 * `fetchAllByCompanyChunked`/`bulkUpsertByExternalRef` might hand back, so
 * this is safe regardless of which shape the value currently has.
 */
function toDateOnly(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Does this ticket have at least one technician actually dispatched to it
 * right now? Read straight off the ticket's OWN embedded `assignments[]` —
 * the full ticket payload is stored verbatim on zentrades_tickets, so this
 * needs no cross-table lookup. This is the fix for the "Open" collision (see
 * mapJobStatus): ZenTrades' "Open" means "not yet completed", not "nothing
 * scheduled" — a ticket with a live assignment is scheduled work, regardless
 * of what its own status word says.
 */
function ticketHasLiveAssignment(payload = {}) {
  return (Array.isArray(payload.assignments) ? payload.assignments : [])
    .some((a) => a && a.isActive !== false && a.isDeleted !== true && a.startTime);
}

// ── Status mappings ──────────────────────────────────────────────────────────

/**
 * ZenTrades `jobStatusId: 1` ("Open") means "not yet completed" — a
 * lifecycle sense — while platform `jobs.status = 'open'` means "nothing
 * scheduled yet". Mapping them 1:1 would put every ZenTrades ticket with an
 * assigned technician into the unscheduled bucket, and the open_job_due_soon
 * sweep would call customers about work that's already booked. Derive from
 * status AND live assignments instead: a live assignment means a technician
 * is actually dispatched, which is `scheduled` in platform vocabulary
 * regardless of what ZenTrades calls it.
 *
 * `isDeleted`/`isActive` on the ticket itself are authoritative — a returned
 * row explicitly flagged that way is really cancelled, unlike mere absence
 * from a sync pull (see services/zentrades-sync.js's absence-warning doc for
 * why absence alone is never trusted).
 */
function mapJobStatus(row) {
  const p = row.payload || {};
  if (p.isDeleted === true || p.isActive === false) return { status: "cancelled", warning: null };

  const statusLabel = String(row.job_status ?? "").trim().toLowerCase();
  if (statusLabel === OPEN_JOB_STATUS_LABEL) {
    return { status: ticketHasLiveAssignment(p) ? "scheduled" : "open", warning: null };
  }
  return {
    status: "open",
    warning: {
      code: "unmapped_job_status",
      message: `Unrecognized ZenTrades jobStatus "${row.job_status}" — defaulted to open. Only "Open" tickets are currently fetched by the sync.`,
    },
  };
}

/**
 * ZenTrades' assignment status vocabulary beyond "Open" is unverified (see
 * migrations/108's header) — only isDeleted/isActive are trustworthy
 * signals today. A plain "Open" -> scheduled default until a real mapping
 * is confirmed against production data carrying other values.
 */
function mapAssignmentStatus(row) {
  const p = row.payload || {};
  if (p.isDeleted === true || p.isActive === false) return "cancelled";
  return "scheduled";
}

// ── Contact dedupe ───────────────────────────────────────────────────────────

/**
 * Merge zentrades_contacts rows (contact_kind: customer | service_address |
 * additional) that share a lowercased email into ONE canonical row, so the
 * same real person doesn't become 2-3 separate platform contacts. Mirrors
 * crm/servicetrade/provider.js's dedupeContactsByEmail: group by email,
 * pick one canonical row per group, fill its blank fields from the others,
 * and return an alias map so callers can resolve ANY of the merged raw refs
 * to the surviving platform contact.
 *
 * Canonical choice is a service_address contact first (the person actually
 * on-site for the visit, closest analogue to InspectPoint's "prefer
 * scheduling role" pick), then customer, then additional — tie-broken by
 * the raw ref string for determinism. This choice has no correctness
 * implications (blank fields are filled from every row in the group either
 * way); it only decides which raw ref becomes the platform row's
 * external_ref.
 *
 * Rows with no email at all are never grouped (each gets a unique key), so
 * a contact with no dedupe key still survives as its own distinct row —
 * required since a real fraction of `additional` contacts carry no email.
 */
function dedupeContactsByEmail(rawContacts) {
  const KIND_PRIORITY = { service_address: 0, customer: 1, additional: 2 };
  const MERGEABLE = ["firstname", "lastname", "name", "displayName", "email", "cellphone", "landline", "ext"];
  const isEmpty = (v) => v == null || (typeof v === "string" && v.trim() === "");

  const groups = new Map();
  for (const row of rawContacts) {
    const email = row.email_lower || (typeof row.payload?.email === "string" ? row.payload.email.trim().toLowerCase() : "");
    const key = email || `no-email:${row.zentrades_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const canonicalRows = [];
  const alias = new Map();
  for (const rows of groups.values()) {
    rows.sort((a, b) => {
      const pa = KIND_PRIORITY[a.contact_kind] ?? 9;
      const pb = KIND_PRIORITY[b.contact_kind] ?? 9;
      if (pa !== pb) return pa - pb;
      return String(a.zentrades_id).localeCompare(String(b.zentrades_id));
    });
    const canonical = { ...rows[0], payload: { ...(rows[0].payload || {}) } };
    for (const dup of rows.slice(1)) {
      const dupPayload = dup.payload || {};
      for (const field of MERGEABLE) {
        if (isEmpty(canonical.payload[field]) && !isEmpty(dupPayload[field])) canonical.payload[field] = dupPayload[field];
      }
      alias.set(String(dup.zentrades_id), String(canonical.zentrades_id));
    }
    alias.set(String(canonical.zentrades_id), String(canonical.zentrades_id));
    canonicalRows.push(canonical);
  }
  return { canonicalRows, alias };
}

// ── Normalizers ──────────────────────────────────────────────────────────────

/**
 * zentrades_customers -> platform `customers`. Unlike InspectPoint's Account
 * (structurally no phone/email at all), ZenTrades customers carry real
 * landline/cellphone/email fields directly — no warning needed for the
 * common case.
 */
function normalizeCustomer(row, { companyId }) {
  if (!row) return null;
  const p = row.payload || {};
  const phone = toE164(p.landline) || toE164(p.cellphone);
  const warnings = [];
  if (!phone) warnings.push({ code: "missing_phone", message: "Customer has no landline or cellphone on file." });
  if (!p.displayName && !p.name) warnings.push({ code: "missing_name", message: "Customer has no name." });
  return {
    companyId,
    externalRef: String(row.zentrades_id),
    source: SOURCE,
    fullName: p.displayName || p.name || null,
    email: p.email || null,
    phone,
    // billingAddress is deliberately not stored anywhere (stripped at raw
    // sync time — service-address-only per product decision), so there is
    // no company-level address to put here.
    addressLine1: null,
    city: null,
    state: null,
    zipcode: null,
    country: "US",
    isActive: row.is_active !== false,
    additionalInformation: {
      zentrades_customer_id: row.zentrades_id,
      customer_identifier: p.customerIdentifier || null,
      customer_unique_id: p.customerUniqueId || null,
      additional_name: p.additionalName || null,
      warnings,
    },
  };
}

/**
 * zentrades_locations -> platform `locations` (from ticket.serviceAddress).
 *
 * ⚠ KNOWN GAP: `do_not_serve` (a hard "never call this address" signal — see
 * migrations/108's header) is recorded here in additionalInformation only.
 * There is no platform `locations.do_not_serve` column and no outreach path
 * checks it yet. This is safe for the current goal (making synced data
 * visible) but MUST be wired into a real column + the call-target queries
 * before this integration is ever used for live customer outreach — a
 * do-not-serve address must never be dialed.
 */
function normalizeLocation(row, { companyId, customerId, primaryContactId = null }) {
  if (!row) return null;
  const p = row.payload || {};
  const phone = toE164(p.landline) || toE164(p.cellphone);
  return {
    companyId,
    externalRef: String(row.zentrades_id),
    source: SOURCE,
    customerId,
    primaryContactId,
    name: p.displayName || p.name || null,
    lat: p.geoLocation?.lat ?? null,
    lon: p.geoLocation?.lng ?? null,
    phone,
    email: p.email || null,
    generalManagerName: null,
    addressLine1: p.addressLine1 || null,
    city: p.city || null,
    state: p.state || null,
    zipcode: p.zipcode || null,
    country: p.country || "US",
    taxable: typeof p.isTaxable === "boolean" ? p.isTaxable : null,
    company: null,
    brand: null,
    isActive: row.is_active !== false,
    additionalInformation: {
      zentrades_location_id: row.zentrades_id,
      // See this function's header — not enforced anywhere yet.
      do_not_serve: row.do_not_serve === true,
      address_line2: p.addressLine2 || null,
      customer_identifier: p.customerIdentifier || null,
      notes: p.notes?.text || null,
    },
  };
}

/**
 * A canonical (post-dedupe) zentrades_contacts row -> platform `contacts`.
 * customer/service_address rows carry real firstname/lastname; `additional`
 * rows carry only `name` and go through splitPersonName.
 */
function normalizeContact(row, { companyId, isPrimary = false }) {
  if (!row) return null;
  const p = row.payload || {};
  let firstName = p.firstname || null;
  let lastName = p.lastname || null;
  if (!firstName && !lastName) {
    const split = splitPersonName(p.name || p.displayName);
    firstName = split.firstName;
    lastName = split.lastName;
  }
  const phone = toE164(p.landline);
  const mobile = toE164(p.cellphone);
  const warnings = [];
  if (!phone && !mobile) warnings.push({ code: "missing_phone", message: "Contact has no landline or cellphone." });

  return {
    companyId,
    externalRef: String(row.zentrades_id),
    source: SOURCE,
    firstName,
    lastName,
    // No separate landline/cellphone columns beyond phone/mobile — `phone`
    // falls back to mobile so a cell-only contact isn't unreachable to code
    // reading only `.phone` (same convention as InspectPoint's normalizeContact).
    phone: phone || mobile,
    mobile,
    alternatePhone: null,
    email: p.email || null,
    type: row.contact_kind || null,
    types: row.contact_kind ? [row.contact_kind] : [],
    contactRole: isPrimary ? "primary" : "general",
    additionalInformation: {
      zentrades_contact_id: row.zentrades_id,
      contact_kind: row.contact_kind,
      ext: p.ext || null,
      warnings,
    },
  };
}

/** zentrades_technicians -> platform `technicians`. Phone is genuinely optional — see migrations/108's header. */
function normalizeTechnician(row, { companyId }) {
  if (!row) return null;
  const p = row.payload || {};
  const firstName = p.firstName || p.firstname || null;
  const lastName = p.lastName || p.lastname || null;
  const phone = toE164(p.landline) || toE164(p.cellphone);
  const warnings = [];
  if (!phone) warnings.push({ code: "missing_phone", message: "Technician has no landline or cellphone on file — confirmation calls cannot be placed to them directly." });
  if (!firstName && !lastName) warnings.push({ code: "missing_name", message: "Technician has no name." });
  return {
    companyId,
    externalRef: String(row.zentrades_id),
    source: SOURCE,
    firstName,
    lastName,
    email: p.email || null,
    phone,
    isActive: row.is_active !== false,
    additionalInformation: {
      zentrades_technician_id: row.zentrades_id,
      username: p.username || null,
      warnings,
    },
  };
}

/** Ticket title: real jobDescription first, else a composed fallback — never a bare id. */
function deriveJobTitle(p, ticketNumber) {
  const desc = String(p.jobDescription || "").trim();
  if (desc) return desc;
  if (p.jobType) return `${p.jobType} — Ticket #${ticketNumber}`;
  return `Ticket #${ticketNumber}`;
}

/**
 * zentrades_tickets -> platform `jobs`.
 *
 * `technicianId` here is best-effort only — ZenTrades assigns technicians
 * per VISIT (assignment), not per ticket, so "the" technician for a
 * multi-visit or multi-tech ticket is genuinely ambiguous. The caller picks
 * the earliest live assignment's technician purely for list/filter
 * convenience; `appointments.technician_id` (one per assignment) is the
 * real, authoritative per-visit assignment and is what confirmation/
 * scheduling logic should read.
 */
function normalizeJob(row, { companyId, customerId, locationId, technicianId = null, primaryContactId = null }) {
  if (!row) return null;
  const p = row.payload || {};
  const { status, warning } = mapJobStatus(row);
  const warnings = warning ? [warning] : [];
  const title = deriveJobTitle(p, row.ticket_number);
  const description = String(p.jobDescription || "").trim() || title;

  return {
    companyId,
    externalRef: String(row.zentrades_id),
    source: SOURCE,
    customerId,
    locationId,
    technicianId,
    primaryContactId,
    title,
    description,
    jobType: p.jobType || null,
    status,
    // A plain UTC-date slice of the ticket's own scheduled window — same
    // class of imprecision several existing normalizers already accept for
    // this secondary DATE column; scheduledWindowStart/End (full TIMESTAMPTZ,
    // used for real scheduling) are unaffected and always correct.
    scheduledDate: toDateOnly(row.scheduled_start),
    scheduledWindowStart: row.scheduled_start || null,
    scheduledWindowEnd: row.scheduled_end || null,
    jobNumber: row.ticket_number || null,
    externalIds: {},
    additionalInformation: {
      zentrades_ticket_id: row.zentrades_id,
      job_status_id: row.job_status_id,
      job_status: row.job_status,
      work_type: p.workType || null,
      work_code: p.workCode || null,
      combined_feature_flag: row.combined_feature_flag,
      campaign_name: p.campaign?.name || null,
      warnings,
    },
  };
}

/** zentrades_appointments (one per assignment, 1:1) -> platform `appointments`. */
function normalizeAppointment(row, { companyId, jobId, technicianId }) {
  if (!row) return null;
  const warnings = [];
  if (!row.scheduled_start) {
    warnings.push({ code: "missing_scheduled_start", message: "Assignment has no start time — inserted as unscheduled, not skipped." });
  }
  const duration = row.scheduled_start && row.scheduled_end
    ? Math.round((new Date(row.scheduled_end).getTime() - new Date(row.scheduled_start).getTime()) / 1000)
    : null;

  return {
    companyId,
    externalRef: String(row.zentrades_id),
    source: SOURCE,
    jobId,
    technicianId,
    status: mapAssignmentStatus(row),
    scheduledStart: row.scheduled_start || null,
    scheduledEnd: row.scheduled_end || null,
    duration,
    additionalInformation: {
      zentrades_assignment_id: row.zentrades_id,
      assignment_status: row.assignment_status,
      assignment_status_cf: row.assignment_status_cf,
      recurring_assignment_id: row.recurring_assignment_id,
      warnings,
    },
  };
}

module.exports = {
  SOURCE,
  splitPersonName,
  toDateOnly,
  ticketHasLiveAssignment,
  mapJobStatus,
  mapAssignmentStatus,
  dedupeContactsByEmail,
  deriveJobTitle,
  normalizeCustomer,
  normalizeLocation,
  normalizeContact,
  normalizeTechnician,
  normalizeJob,
  normalizeAppointment,
};
