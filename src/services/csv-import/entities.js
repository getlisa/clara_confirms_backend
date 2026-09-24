/**
 * Typed import rows (from mapper.js) -> the five platform entity payloads,
 * plus the field descriptors `db.bulkUpsertByExternalRef` writes them with.
 *
 * ── Why CSV needs its own field descriptors ─────────────────────────────────
 *
 * The obvious move is to reuse the InspectPoint/ServiceTrade descriptors, and
 * it is wrong. Those plain-overwrite `scheduled_start` and `jobs.status` on
 * every sync, and the comment in crm/inspectpoint/provider.js says exactly why
 * that is safe there: *"the CRM owns the schedule; a local reschedule reaches
 * the CRM through the write-back mirror and comes back through this column."*
 *
 * CSV has no write-back mirror. A spreadsheet uploaded tomorrow morning was
 * exported last night, so it is **stale by construction** — it cannot know
 * about a reschedule Clara agreed with the customer at 4pm. Reusing those
 * descriptors would let a routine re-upload silently revert a customer's
 * agreed time and re-arm a confirmation call. Hence the guards below.
 */

const crypto = require("node:crypto");
const { toLocalDateOnly } = require("../../utils/timezone");

const SOURCE = "csv";

/**
 * Version prefix on every DERIVED external_ref.
 *
 * Derived keys are best-effort matching, not identity: "ACME Inc" and
 * "Acme, Inc." are the same company to a human and two different slugs to us.
 * Versioning the algorithm means a future improvement can be rolled out
 * without silently orphaning every row the old one produced — the prefix
 * changes, the old rows stay findable, and a migration can map between them.
 */
const REF_VERSION = "csvv1";

/** Lowercase, strip punctuation, collapse whitespace — the matching form of a name. */
function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

/**
 * A stable, short external_ref for an entity we have no real id for.
 * Hashed rather than raw so a 200-character company name can't overflow the
 * column, and prefixed so the entity kind is readable in the database.
 */
function derivedRef(kind, ...parts) {
  const basis = parts.map((p) => slugify(p)).filter(Boolean).join("|");
  const hash = crypto.createHash("sha1").update(basis).digest("hex").slice(0, 16);
  return `${REF_VERSION}:${kind}:${hash}`;
}

/**
 * The job a visit belongs to.
 *
 * Comes from an explicit job column when the file has one, and otherwise from
 * the row's own reference — so a single-visit-per-job file (the common case)
 * produces one job per row, and a file that really does group several visits
 * under one job says so in a column of its own.
 *
 * Deliberately NOT inferred by stripping a numeric suffix off the reference:
 * "WO-1001-2" is visit 2 of WO-1001 at one company and a perfectly ordinary
 * one-visit job number at the next, and guessing wrong silently merges
 * unrelated work onto a single job — which then makes the agent offer to
 * "confirm the rest" of visits that have nothing to do with each other.
 */
function jobRefFor(row) {
  return String(row.jobReference || row.reference);
}

/**
 * Import rows -> `{customers, contacts, locations, jobs, appointments}`, each
 * an array of payloads shaped for bulkUpsertByExternalRef (companyId,
 * externalRef, source, additionalInformation + the descriptor keys).
 *
 * Entities are deduped across rows by external_ref, keeping the FIRST
 * occurrence: rows for the same customer repeat their name and address on
 * every line, and a later row's blank address should not erase an earlier
 * row's filled one.
 *
 * @param {Array<object>} rows — mapper.js output
 * @param {{companyId: number|string, timezone: string}} ctx
 */
function buildEntities(rows, { companyId, timezone }) {
  const customers = new Map();
  const locations = new Map();
  const contacts = new Map();
  const jobs = new Map();
  const appointments = [];

  /** Keep the first write for a ref; fill only blanks from later rows. */
  const put = (map, ref, build) => {
    if (!map.has(ref)) { map.set(ref, build()); return; }
    const existing = map.get(ref);
    const incoming = build();
    for (const [k, v] of Object.entries(incoming)) {
      if (existing[k] == null && v != null) existing[k] = v;
    }
  };

  for (const row of rows) {
    const customerRef = derivedRef("cust", row.customerName, row.email || "");
    put(customers, customerRef, () => ({
      companyId,
      externalRef: customerRef,
      source: SOURCE,
      fullName: row.customerName,
      email: row.email,
      phone: row.phone,
      addressLine1: row.address.addressLine1,
      city: row.address.city,
      state: row.address.state,
      zipcode: row.address.zipcode,
      additionalInformation: { imported_from: "csv", source_row: row.rowNumber, derived_from: { name: row.customerName, email: row.email } },
    }));

    // A location only exists when the file actually carries an address —
    // inventing one from the customer name would produce a site nobody can
    // find. Jobs simply have a null location_id otherwise.
    let locationRef = null;
    if (row.address.addressLine1) {
      locationRef = derivedRef("loc", row.address.addressLine1, row.address.city, row.address.zipcode);
      const ref = locationRef;
      put(locations, ref, () => ({
        companyId,
        externalRef: ref,
        source: SOURCE,
        customerRef,
        name: row.address.addressLine1,
        addressLine1: row.address.addressLine1,
        city: row.address.city,
        state: row.address.state,
        zipcode: row.address.zipcode,
        additionalInformation: { imported_from: "csv", source_row: row.rowNumber },
      }));
    }

    // Likewise a contact only when the file names a person. The customer's own
    // phone/email live on the customer row; a contact row for "Acme Inc" with
    // no human name would just be a duplicate the agent might greet by name.
    let contactRef = null;
    if (row.contactName) {
      contactRef = derivedRef("contact", row.contactName, row.email || row.phone || "");
      const ref = contactRef;
      put(contacts, ref, () => ({
        companyId,
        externalRef: ref,
        source: SOURCE,
        ...splitName(row.contactName),
        email: row.email,
        phone: row.phone,
        contactRole: "general",
        additionalInformation: { imported_from: "csv", source_row: row.rowNumber },
      }));
    }

    const jobRef = jobRefFor(row);
    put(jobs, jobRef, () => ({
      companyId,
      externalRef: jobRef,
      source: SOURCE,
      customerRef,
      locationRef,
      contactRef,
      title: row.serviceDescription || `Visit ${jobRef}`,
      description: row.serviceDescription,
      jobType: row.serviceDescription,
      jobNumber: jobRef,
      // See JOB_FIELDS — 'scheduled', never 'open'.
      status: "scheduled",
      scheduledDate: toLocalDateOnly(row.scheduledStart, timezone),
      additionalInformation: { imported_from: "csv", source_row: row.rowNumber },
    }));

    appointments.push({
      companyId,
      externalRef: String(row.reference),
      source: SOURCE,
      jobRef,
      technicianName: row.technicianName,
      scheduledStart: row.scheduledStart,
      scheduledEnd: row.scheduledEnd,
      status: "scheduled",
      duration: row.scheduledEnd
        ? Math.round((new Date(row.scheduledEnd) - new Date(row.scheduledStart)) / 1000)
        : null,
      additionalInformation: {
        imported_from: "csv",
        source_row: row.rowNumber,
        // Every column we don't model, kept verbatim — this is what lets the
        // agent answer "what's the gate code?" without us having modelled one.
        ...(Object.keys(row.extra).length ? { csv_columns: row.extra } : {}),
      },
    });
  }

  return {
    customers: [...customers.values()],
    locations: [...locations.values()],
    contacts: [...contacts.values()],
    jobs: [...jobs.values()],
    appointments,
  };
}

/** "Jane Smith" -> {firstName, lastName}; mirrors inspectpoint/normalize.js's splitPersonName. */
function splitName(name) {
  const s = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!s) return { firstName: null, lastName: null };
  if (s.includes(",")) {
    const [last, ...rest] = s.split(",");
    return { firstName: rest.join(",").trim() || null, lastName: last.trim() || null };
  }
  const parts = s.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

// ── Field descriptors ───────────────────────────────────────────────────────

const CUSTOMER_FIELDS = [
  { column: "full_name", key: "fullName" },
  { column: "email", key: "email" },
  { column: "phone", key: "phone" },
  { column: "address_line1", key: "addressLine1" },
  { column: "city", key: "city" },
  { column: "state", key: "state" },
  { column: "zipcode", key: "zipcode" },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const LOCATION_FIELDS = [
  { column: "customer_id", key: "customerId" },
  { column: "name", key: "name" },
  { column: "address_line1", key: "addressLine1" },
  { column: "city", key: "city" },
  { column: "state", key: "state" },
  { column: "zipcode", key: "zipcode" },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

const CONTACT_FIELDS = [
  { column: "first_name", key: "firstName" },
  { column: "last_name", key: "lastName" },
  { column: "email", key: "email" },
  { column: "phone", key: "phone" },
  { column: "contact_role", key: "contactRole", transform: (v) => v || "general" },
];

const JOB_FIELDS = [
  { column: "customer_id", key: "customerId" },
  { column: "location_id", key: "locationId" },
  { column: "primary_contact_id", key: "primaryContactId" },
  { column: "title", key: "title" },
  { column: "description", key: "description" },
  { column: "job_type", key: "jobType" },
  { column: "job_number", key: "jobNumber" },
  {
    column: "status",
    key: "status",
    // 'scheduled', NOT InspectPoint's `v || "open"`. The confirmation sweep
    // matches `j.status IN ('scheduled','rescheduled')` (services/scheduler.js's
    // processScheduledUnconfirmed), so an 'open' job is never swept — the
    // import would look perfectly successful and call nobody.
    transform: (v) => v || "scheduled",
    // ...and on re-import, never drag a job back out of a state a human or the
    // agent put it in. 'confirmed' is written by job-confirmation-status.js,
    // 'cancelled' by routes/jobs.js; resetting either to 'scheduled' would
    // re-arm calls to a customer who already cancelled.
    updateExpr: `status = CASE WHEN jobs.status IN ('confirmed','cancelled','completed','in_progress') THEN jobs.status ELSE EXCLUDED.status END`,
  },
  { column: "scheduled_date", key: "scheduledDate" },
];

const APPOINTMENT_FIELDS = [
  { column: "job_id", key: "jobId" },
  { column: "technician_id", key: "technicianId" },
  {
    column: "scheduled_start",
    key: "scheduledStart",
    // THE guard that distinguishes CSV from every other provider. See this
    // file's header: a re-uploaded export is stale by construction, so it must
    // not move a visit whose time the customer has already agreed to. Once the
    // office actually wants to move such a visit they can cancel/recreate it,
    // or clear the confirmation — both explicit acts, unlike a nightly upload.
    updateExpr: `scheduled_start = CASE WHEN appointments.status IN ('confirmed','rescheduled') THEN appointments.scheduled_start ELSE EXCLUDED.scheduled_start END`,
  },
  {
    column: "scheduled_end",
    key: "scheduledEnd",
    updateExpr: `scheduled_end = CASE WHEN appointments.status IN ('confirmed','rescheduled') THEN appointments.scheduled_end ELSE EXCLUDED.scheduled_end END`,
  },
  {
    column: "status",
    key: "status",
    transform: (v) => v || "scheduled",
    // Same guard InspectPoint uses, for the same reason: CSV has no
    // 'confirmed' state of its own, so a plain overwrite would reset every
    // appointment the agent confirmed back to 'scheduled' on the next upload.
    updateExpr: `status = CASE WHEN appointments.status IN ('confirmed','rescheduled','cancelled') THEN appointments.status ELSE EXCLUDED.status END`,
  },
  { column: "duration", key: "duration" },
];

module.exports = {
  buildEntities,
  derivedRef,
  jobRefFor,
  splitName,
  slugify,
  SOURCE,
  REF_VERSION,
  CUSTOMER_FIELDS,
  LOCATION_FIELDS,
  CONTACT_FIELDS,
  JOB_FIELDS,
  APPOINTMENT_FIELDS,
};
