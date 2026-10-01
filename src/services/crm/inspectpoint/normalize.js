/**
 * inspectpoint_* raw rows -> platform tables (customers/locations/contacts/
 * technicians/jobs/appointments), source='inspectpoint'.
 *
 * Caller is responsible for resolving every FK id (customerId, locationId,
 * technicianId, primaryContactId) via its own external_ref lookup before
 * calling these — same convention as crm/servicetrade/normalize.js.
 */

const { toE164 } = require("../../../utils/phone");

const SOURCE = "inspectpoint";

/**
 * One `name` string -> {firstName, lastName}. Deliberately conservative: no
 * suffix/particle/title special-casing (every such heuristic is confidently
 * wrong some fraction of the time) — just the "Last, First" comma form InspectPoint
 * actually uses for some contacts, and "everything but the last token is the
 * first name" otherwise. The untouched original always survives in
 * additionalInformation.inspectpoint_name, so a better splitter can be
 * re-run over raw data later without re-fetching anything.
 */
function splitPersonName(name) {
  if (!name) return { firstName: null, lastName: null };
  const s = String(name).trim().replace(/\s+/g, " ");
  if (!s) return { firstName: null, lastName: null };
  if (s.includes(",")) {
    const [last, ...rest] = s.split(",");
    const firstName = rest.join(",").trim() || null;
    const lastName = last.trim() || null;
    return { firstName, lastName };
  }
  const parts = s.split(" ");
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

function toFiniteNumber(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The `YYYY-MM-DD` prefix of an ISO string, WITHOUT converting to UTC first
 * — `scheduled_time_iso` is already rendered in tenant-local time (that is
 * the entire reason the field exists over `scheduled_date`), so
 * `new Date(iso).toISOString().slice(0,10)` would silently shift evening
 * appointments to the next UTC day. */
function tenantLocalDatePrefix(isoString) {
  if (!isoString || typeof isoString !== "string") return null;
  return isoString.slice(0, 10);
}

/**
 * `start` + `minutes`, as a UTC ISO string — for turning InspectPoint's
 * duration fields (visit `duration_mins`, inspection `projected_duration_mins`)
 * into a real end instant. Returns null unless BOTH inputs are usable, so a
 * missing duration never silently produces a zero-length window.
 */
function addMinutes(start, minutes) {
  if (!start || minutes == null) return null;
  const ms = new Date(start).getTime();
  const mins = Number(minutes);
  if (Number.isNaN(ms) || !Number.isFinite(mins) || mins <= 0) return null;
  return new Date(ms + mins * 60_000).toISOString();
}

/**
 * The trade/service name for what this inspection actually covers — the
 * platform's `service_lines.name`, and the thing the agent says out loud
 * ("your Fire Extinguishers visit").
 *
 * Measured against a live tenant's 98 open inspections: `inspection_type` is
 * present on 59, a `custom_inspections[]` entry names another 13, and 26 have
 * neither. So this returns null for that last group rather than inventing a
 * trade category — frequency ("Semi Annual") is a cadence, not a service
 * line, and labelling a row "Semi Annual" in a trade column would be wrong.
 * Those inspections still get a real description via
 * buildInspectionDescription(); they just carry no service line.
 */
function deriveServiceLineName(payload = {}) {
  const typeName = payload.inspection_type?.name || payload.resolved_type_name || null;
  if (typeName) return String(typeName).trim() || null;
  const custom = (payload.custom_inspections || []).map((c) => c?.name).find((n) => n && String(n).trim());
  return custom ? String(custom).trim() : null;
}

/** Stable external_ref for a derived service line — the type id when there is one, else the name itself. */
function deriveServiceLineRef(payload = {}) {
  if (payload.inspection_type?.id != null) return `type:${payload.inspection_type.id}`;
  const name = deriveServiceLineName(payload);
  return name ? `name:${name.toLowerCase()}` : null;
}

/**
 * The human label for the inspection as a whole — used for the job title and
 * job_type. Prefers the real service line, falling back to the frequency
 * cadence so a customer hears "your Semi Annual Inspection" rather than
 * "Inspection 2839".
 */
function deriveInspectionLabel(payload = {}) {
  const serviceLine = deriveServiceLineName(payload);
  if (serviceLine) return serviceLine;
  const frequencyLabel = payload.frequency?.frequency || null;
  return frequencyLabel ? `${frequencyLabel} Inspection` : null;
}

/** "about 2 hours" / "about 90 minutes" — spoken-friendly, for the description. */
function humanDuration(mins) {
  const n = Number(mins);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 60) return `about ${n} minutes`;
  const hours = n / 60;
  const rounded = Number.isInteger(hours) ? hours : Math.round(hours * 10) / 10;
  return `about ${rounded} hour${rounded === 1 ? "" : "s"}`;
}

/**
 * InspectPoint has NO description field on an inspection — verified against
 * the live API on all three endpoints that return one (v1 list, v2 list, v2
 * detail). The nearest candidates are empty in practice: across 98 real open
 * inspections, technician_instructions was set on 4 and recommendations /
 * internal_notes on none.
 *
 * So the description is COMPOSED from the fields that are actually populated
 * — cadence, service line and planned duration are all ~100% present — rather
 * than left null. This is what feeds jobs.description and
 * appointment_services.description, i.e. what the confirmation agent reads
 * out when the customer asks what the visit covers. Any real
 * technician_instructions text is appended verbatim, never replaced.
 */
function buildInspectionDescription(payload = {}) {
  const frequency = payload.frequency?.frequency || null;
  const serviceLine = deriveServiceLineName(payload);
  const duration = humanDuration(payload.projected_duration_mins);

  const subject = [frequency, serviceLine].filter(Boolean).join(" ");
  let sentence = subject ? `${subject} inspection` : "Inspection";
  if (duration) sentence += ` (${duration})`;

  const instructions = (payload.technician_instructions || "").trim();
  return instructions ? `${sentence}. ${instructions}` : sentence;
}

/**
 * inspection_type / custom_inspections -> platform `service_lines`.
 * Returns null when the inspection names no service line at all (26 of 98 on
 * the live tenant) — the caller skips those rather than creating a placeholder.
 */
/**
 * A DEFICIENCY as a service line — the repairable thing.
 *
 * service_lines used to be derived from `inspection_type`, which also feeds
 * jobs.job_type; one field was serving two concepts. Inspection type keeps the
 * job_type role and the catalog now holds what you would actually perform a
 * service on.
 *
 * One row per UNRESOLVED deficiency (the caller filters), keyed
 * `deficiency:<ip_id>` so it is stable across syncs.
 */
function normalizeDeficiencyServiceLine(row, { companyId }) {
  if (!row || row.inspectpoint_id == null) return null;
  if (row.is_resolved === true) return null;
  const name = buildDeficiencyLabel(row);
  if (!name) return null;
  return {
    companyId,
    externalRef: `deficiency:${row.inspectpoint_id}`,
    source: SOURCE,
    name,
    // The equipment family, which is the closest thing InspectPoint has to a
    // trade. Four of its six values are internal jargon, so consumers treat
    // this as a grouping key, not a label — see SPEAKABLE_ASSET_TYPES in
    // services/job-confirmation-context.js.
    trade: deficiencyAssetType(row),
    abbr: null,
    icon: null,
  };
}

function normalizeServiceLine(payload, { companyId }) {
  const name = deriveServiceLineName(payload);
  const externalRef = deriveServiceLineRef(payload);
  if (!name || !externalRef) return null;
  return {
    companyId,
    externalRef,
    source: SOURCE,
    name,
    // InspectPoint has no trade/abbr/icon vocabulary of its own; leaving these
    // null is honest and keeps the column meaning consistent with ServiceTrade's.
    trade: null,
    abbr: null,
    icon: null,
  };
}

/**
 * One `appointment_services` row per visit — the join that makes
 * job-confirmation-context's `service_details` ("service line" + description)
 * non-empty for InspectPoint. Created for EVERY appointment, including the
 * ones with no resolvable service line: serviceLineId is then null but the
 * composed description still tells the customer what the visit is.
 */
function normalizeAppointmentService(row, { companyId, appointmentId, jobId, serviceLineId, jobPayload = {} }) {
  if (!row || !appointmentId) return null;
  const p = row.payload || {};
  const durationMins = p.duration_mins ?? jobPayload.projected_duration_mins ?? null;
  const windowStart = row.scheduled_date || null;
  return {
    companyId,
    // One service per visit, so the visit's own id is a stable unique ref.
    externalRef: `visit:${row.inspectpoint_id}`,
    source: SOURCE,
    appointmentId,
    jobId,
    serviceLineId,
    status: mapVisitStatus(row.visit_status).status,
    completion: null,
    description: buildInspectionDescription(jobPayload),
    windowStart,
    windowEnd: addMinutes(windowStart, durationMins),
    duration: durationMins != null ? Number(durationMins) * 60 : null, // seconds, matching appointments.duration
    estimatedPrice: null,
    asset: {},
  };
}

// ── Status mappings ──────────────────────────────────────────────────────────

const JOB_STATUS_MAP = {
  // InspectPoint's own dominant state, and the one the customer/technician see
  // in their CRM — kept as a distinct platform status (migration 106) rather
  // than flattened into `open`, so our UI can show the same word theirs does.
  // Behaviourally identical to `open`: see UNSCHEDULED_JOB_STATUSES in
  // db/jobs.js, which every sweep and promotion matches on.
  pending: "pending",
  // Deliberately still `open`: these are genuinely different pre-scheduling
  // states, not the "Pending" the customer is shown.
  quoted: "open",
  proposal_approved: "open",
  scheduled: "scheduled",
  started: "in_progress",
  waiting_for_review: "completed",
  ready_to_generate: "completed",
  completed: "completed",
  invoiced: "completed",
  paid: "completed",
  cancelled: "cancelled",
  cancelled_by_parent_tenant: "cancelled",
  deleted_by_technician: "cancelled",
};
// `processing`/`error` are integration plumbing, not a business state a
// customer-facing agent should ever act on — map to `open` (the one status
// the confirmation-status sync never overwrites) with a warning, rather than
// silently guessing a real value.
const AMBIGUOUS_STATUS_CODES = new Set(["processing", "error"]);

/**
 * Inspection status_code -> job status.
 *
 * An UNRECOGNISED code now becomes "unknown", not "open". It warned before, but
 * "open" means live work: the sweeps would pick the job up and the agent would
 * call about an inspection whose real state we could not read. "unknown"
 * (migration 111) is deliberately outside those sweeps — see mapVisitStatus for
 * the same reasoning, and migration 104 for why the raw status_code is kept
 * verbatim so a corrected mapping needs no re-fetch.
 *
 * AMBIGUOUS codes keep defaulting to "open": those are known integration
 * plumbing rather than states we failed to recognise, and treating a known
 * quantity as unknown would hide real work.
 */
function mapJobStatus(statusCode) {
  const mapped = JOB_STATUS_MAP[statusCode];
  if (mapped) return { status: mapped, warning: null };

  if (AMBIGUOUS_STATUS_CODES.has(statusCode)) {
    return {
      status: "open",
      warning: {
        code: "ambiguous_status_code",
        message: `InspectPoint status_code "${statusCode}" is integration plumbing, not a business state — defaulted to open.`,
      },
    };
  }
  return {
    status: "unknown",
    warning: {
      code: "unmapped_status_code",
      message: `Unrecognized InspectPoint status_code "${statusCode}" — stored as unknown so it cannot be dispatched. Raw value kept on the raw row.`,
    },
  };
}

const VISIT_STATUS_MAP = {
  scheduled: "scheduled",
  // Faithful now that migration 111 added the value. This used to be mapped to
  // "scheduled" purely because the appointments CHECK had no in_progress.
  started: "in_progress",
  complete: "completed",
  cancelled: "cancelled",
};

/**
 * Visit status -> appointment status.
 *
 * WHY THIS RETURNS "unknown" RATHER THAN A DEFAULT. This used to be
 * `VISIT_STATUS_MAP[visitStatus] || "scheduled"` with no warning, which meant a
 * visit status we had never seen silently became a SCHEDULED APPOINTMENT — a row
 * the dispatcher picks up and the agent then calls a real customer about. An
 * unrecognised upstream state is the last thing that should trigger outbound
 * contact.
 *
 * "unknown" (migration 111) is visible and INERT: it is not in the sweeps that
 * pick work up, so the row surfaces for a human instead of acting on its own.
 * The raw value survives in inspectpoint_appointments.visit_status, so a better
 * mapping can be re-run over stored data without re-fetching.
 *
 * InspectPoint can add statuses at any time; this is the path that stays safe
 * when it does.
 *
 * @returns {{status: string, warning: object|null}}
 */
function mapVisitStatus(visitStatus) {
  // A genuinely absent status is not an unknown one: InspectPoint leaves it null
  // on unscheduled visits, which migration 104 documents as a real, valid row.
  if (visitStatus == null || visitStatus === "") {
    return { status: "scheduled", warning: null };
  }
  const mapped = VISIT_STATUS_MAP[visitStatus];
  if (mapped) return { status: mapped, warning: null };
  return {
    status: "unknown",
    warning: {
      code: "unmapped_visit_status",
      message: `Unrecognized InspectPoint visit_status "${visitStatus}" — stored as unknown so it cannot be dispatched. Raw value kept on the raw row.`,
    },
  };
}

// ── Normalizers ──────────────────────────────────────────────────────────────

/** inspectpoint_customers -> platform `customers` (from Account) */
/**
 * Turn an inspector's checklist item into something that can be spoken.
 *
 * `display_name` is the QUESTION the inspector answered, not the problem:
 * measured on the live tenant, 231 of 436 open rows end in "?" ("Is wiring
 * waterproof?", "Are the proper nozzle covers in place?") and 23 are empty.
 * Read aloud verbatim the agent interrogates the customer instead of reporting
 * a fault.
 *
 * This does NOT try to negate the question into a statement — no deterministic
 * rule turns "Is wiring waterproof?" into "wiring is not waterproof" reliably,
 * and inventing the negation on a compliance topic is exactly the kind of
 * guess worth refusing. It strips the question mark so nothing reads as a
 * question, and the prompt is told these are FAILED checks. Falls back through
 * notes -> asset type, so a row is never nameless.
 */
/**
 * The best available description of the fault, in priority order.
 *
 * `asset_details.Question` + `Answer` is the real content and is present on
 * 295 of 436 live open rows:
 *     Question: "Check operation of micro switch"   Answer: "No"
 *     Question: "Door Inside/Outside"               Answer: "Fail"
 * That pair states the failure outright, which is why it now outranks
 * `display_name` — 53% of those are the inspector's QUESTION ("Is wiring
 * waterproof?") and read aloud verbatim the agent interrogates the customer.
 *
 * Still NO invented negation: nothing here turns "Is wiring waterproof?" into
 * "wiring is not waterproof". `Answer` supplies the failure when we have it,
 * and when we do not we say the flat thing rather than guess.
 */
function buildDeficiencyLabel(row) {
  const payload = row.payload || {};
  const asset = payload.asset_details || {};

  const question = String(asset.Question || "").trim().replace(/\s*\?+\s*$/, "");
  const answer = String(asset.Answer || "").trim();
  if (question && answer) return `${question} — ${answer}`;
  if (question) return question;

  const displayName = String(asset["Display Name"] || "").trim();
  if (displayName) return displayName;

  return cleanDeficiencyLabel(row);
}

/** Previous behaviour, now the FALLBACK chain behind buildDeficiencyLabel. */
function cleanDeficiencyLabel(row) {
  const payload = row.payload || {};
  const raw = String(row.display_name || payload.display_name || "").trim();
  if (raw) return raw.replace(/\s*\?+\s*$/, "").trim();

  const notes = String(row.notes || payload.notes || "").trim();
  if (notes) return notes.split(/\r?\n/)[0].slice(0, 120);

  const asset = payload.asset_details || {};
  const assetType = asset["Equipment type"] || asset["Asset Type"] || asset["System/Asset Type"];
  return assetType ? `Unspecified ${String(assetType).toLowerCase()} item` : "Unspecified item";
}

/**
 * The equipment family a deficiency sits on — "Fire Suppression", "Equipment".
 * `System/Asset Type` is the only asset_details key present on 100% of rows
 * (439/439), which is why the agent's grouping is built on it rather than on
 * the richer but patchy keys like "Equipment type" (75/439).
 */
function deficiencyAssetType(row) {
  const asset = (row.payload || {}).asset_details || {};
  const v = asset["System/Asset Type"] || asset["Asset Type"] || asset["Equipment type"] || null;
  return v ? String(v).trim() : null;
}

/**
 * Raw deficiency -> canonical `deficiencies` row.
 *
 * `locationId` is resolved by the caller from inspectpoint_location_id, which
 * the raw layer took straight from the v1 payload's building.id.
 * `jobId` is usually NULL and that is expected: the inspection that raised a
 * deficiency is normally older than our inspection sync window (measured: we
 * hold 2 of the 159 inspections referenced). Location is the reliable link.
 */
function normalizeDeficiency(row, { companyId, locationId = null, jobId = null, serviceLineId = null }) {
  if (!row || row.inspectpoint_id == null) return null;
  // RESOLVED DEFICIENCIES ARE NOT NORMALIZED AT ALL. A fixed fault is not
  // something to offer to repair, and carrying it forward would mean the agent
  // and the UI both had to remember to filter it out everywhere. Dropping it
  // here makes "only open work" the contract rather than a convention.
  if (row.is_resolved === true) return null;

  const payload = row.payload || {};
  const label = buildDeficiencyLabel(row);
  return {
    companyId,
    externalRef: String(row.inspectpoint_id),
    source: SOURCE,
    locationId,
    jobId,
    refNumber: row.reference_number || payload.reference_number || null,
    name: label,
    description: String(row.notes || payload.notes || "").trim() || null,
    // Captured, but nothing depends on it: null on 436 of 439 live rows.
    status: row.deficiency_status || null,
    isResolved: false, // guaranteed by the guard above
    openedAt: row.date_opened || null,
    resolvedAt: null,
    serviceLineId,
    // The InspectPoint inspection this fault was raised on. Present on 436/436,
    // but deliberately not an FK — those inspections are Completed / Waiting
    // for Review and absent from `jobs` by design (see migration 111).
    externalParentRef: row.inspectpoint_inspection_id != null
      ? String(row.inspectpoint_inspection_id)
      : null,
    // Served to the frontend VERBATIM. Six different asset_details key sets
    // with no common schema beyond System/Asset Type, so flattening would fit
    // one shape and misrepresent the other five.
    detail: {
      asset_details: payload.asset_details || {},
      related_device: payload.related_device || null,
      inspection: payload.inspection || null,
    },
    additionalInformation: {
      inspectpoint_deficiency_id: String(row.inspectpoint_id),
      asset_type: deficiencyAssetType(row),
      resolution_status: row.resolution_status || null,
      unique_id: row.unique_id || null,
      inspection_id: row.inspectpoint_inspection_id ?? null,
    },
  };
}

/**
 * A BUILDING becomes the customer — not the Account.
 *
 * ── Why this changed ───────────────────────────────────────────────────────
 * Every InspectPoint Account structurally has no phone and no email field at
 * all, on 100% of rows. The Building is where `phone_number` lives. So the
 * entity we actually call was never the one stored as the customer, and the
 * confirmation email had to fall back to the location name to avoid reading a
 * raw phone number aloud as the customer's name.
 *
 * A Building now normalizes into BOTH `customers` (here) and `locations`
 * (normalizeLocation), sharing one external_ref. That is safe because each
 * table has its own (company_id, external_ref, source) unique index — and it
 * keeps `jobs.location_id` populated, which the confirmation email's site name
 * and the location deficiency panel both depend on.
 *
 * The Account is not lost: its name and billing address are carried in
 * additional_information.inspectpoint_account for anything that needs the
 * billing entity.
 *
 * @param {object} row               an `inspectpoint_locations` (Building) raw row
 * @param {object|null} accountRow   the Building's `inspectpoint_customers`
 *                                   (Account) row, when we hold it — reference only
 */
function normalizeCustomer(row, { companyId, accountRow = null }) {
  if (!row) return null;
  const p = row.payload || {};
  const account = accountRow?.payload || {};

  const warnings = [];
  if (!p.name) warnings.push({ code: "missing_name", message: "Building has no name." });
  // Worth recording per row, because recipient resolution still prefers a
  // contact where one exists — but unlike the Account this is now the
  // exception rather than every single row.
  if (!p.phone_number) {
    warnings.push({ code: "missing_phone", message: "Building has no phone number — recipient resolution must fall back to a contact." });
  }

  return {
    companyId,
    externalRef: String(row.inspectpoint_id),
    source: SOURCE,
    fullName: p.name || null,
    email: null,
    // The whole point of the re-map: a callable customer record.
    phone: toE164(p.phone_number),
    // The SITE address, not the Account's billing address — this is the
    // customer the agent talks to about a visit.
    addressLine1: p.address1 || null,
    city: p.city || null,
    state: p.state || null,
    zipcode: p.zip || null,
    country: "US",
    isActive: row.is_active !== false,
    additionalInformation: {
      inspectpoint_building_id: row.inspectpoint_id,
      reference_number: p.reference_number || null,
      external_id: p.external_id || null,
      site_identification: p.site_identification || null,
      tags: p.tags || null,
      custom_fields: p.custom_fields || null,
      // The billing entity, preserved rather than discarded.
      inspectpoint_account: accountRow
        ? {
            id: accountRow.inspectpoint_id,
            name: account.name || null,
            billing_address1: account.billing_address1 || null,
            billing_address2: account.billing_address2 || null,
            billing_city: account.billing_city || null,
            billing_state: account.billing_state || null,
            billing_zip: account.billing_zip || null,
            reference_number: account.reference_number || null,
          }
        : null,
      warnings,
    },
  };
}

/**
 * inspectpoint_locations -> platform `locations` (from Building).
 * `primaryContactId` has no source field on InspectPoint's side — the caller
 * resolves it from the contacts pass (roles ∋ 'scheduling' > 'owner' > sole
 * contact > null) and passes it in; see the provider's building-contact pass.
 */
function normalizeLocation(row, { companyId, customerId, primaryContactId = null }) {
  if (!row) return null;
  const p = row.payload || {};
  return {
    companyId,
    externalRef: String(row.inspectpoint_id),
    source: SOURCE,
    customerId,
    primaryContactId,
    name: p.name || null,
    lat: toFiniteNumber(p.latitude),
    lon: toFiniteNumber(p.longitude),
    phone: toE164(p.phone_number),
    email: null,
    generalManagerName: null,
    addressLine1: p.address1 || null,
    city: p.city || null,
    state: p.state || null,
    zipcode: p.zip || null,
    country: "US",
    taxable: null,
    company: p.account_id != null ? { id: p.account_id, name: p.account_name || null } : null,
    brand: null,
    isActive: p.active !== false,
    additionalInformation: {
      inspectpoint_building_id: row.inspectpoint_id,
      notes: p.notes || null,
      territory: p.territory || null,
      time_zone_override: p.time_zone_override || null,
      reference_number: p.reference_number || null,
      external_id: p.external_id || null,
      contract_start_date: p.contract_start_date || null,
      contract_expiration_date: p.contract_expiration_date || null,
      custom_fields: p.custom_fields || null,
      sales_people: p.sales_people || null,
      address2: p.address2 || null,
    },
  };
}

/** inspectpoint_contacts -> platform `contacts` (from Contact) */
function normalizeContact(row, { companyId, isPrimary = false }) {
  if (!row) return null;
  const p = row.payload || {};
  const { firstName, lastName } = splitPersonName(p.name);
  const cell = toE164(p.cell_phone_number);
  const home = toE164(p.home_phone_number);
  const business = toE164(p.business_phone_number);
  const warnings = [];
  if (!business && !cell && !home) warnings.push({ code: "missing_phone", message: "Contact has no phone or mobile number." });

  const roleUnion = new Set();
  for (const t of Array.isArray(p.account_contact_types) ? p.account_contact_types : []) {
    if (t) roleUnion.add(String(t).toLowerCase());
  }
  for (const b of Array.isArray(p.buildings) ? p.buildings : []) {
    for (const r of Array.isArray(b?.roles) ? b.roles : []) {
      if (r) roleUnion.add(String(r).toLowerCase());
    }
  }

  return {
    companyId,
    externalRef: String(row.inspectpoint_id),
    source: SOURCE,
    firstName,
    lastName,
    // business -> phone, cell -> mobile, home -> alternate_phone. `phone`
    // additionally falls back to cell/home so a contact with only a cell
    // number doesn't look unreachable to code that reads only `.phone`
    // (contactToRecipient reads phone || mobile || alternate_phone).
    phone: business || cell || home || null,
    mobile: cell,
    alternatePhone: home,
    email: p.email || null,
    type: p.title || null,
    types: [...roleUnion],
    contactRole: isPrimary ? "primary" : "general",
    additionalInformation: {
      inspectpoint_contact_id: row.inspectpoint_id,
      inspectpoint_name: p.name || null,
      // Never let the fax number anywhere near a phone column — a resolver
      // that reads .phone/.mobile/.alternate_phone would happily dial or SMS it.
      business_fax_number: p.business_fax_number || null,
      reference_number: p.reference_number || null,
      external_id: p.external_id || null,
      warnings,
    },
  };
}

/** inspectpoint_technicians -> platform `technicians`. Caller filters out
 * `payload.system === true` rows (InspectPoint service accounts, not people)
 * before this is ever called — see the provider's technicians pass. */
function normalizeTechnician(row, { companyId }) {
  if (!row) return null;
  const p = row.payload || {};
  const { firstName, lastName } = splitPersonName(p.name);
  const phone = toE164(p.phone_number);
  const warnings = [];
  if (!phone) warnings.push({ code: "missing_phone", message: "Technician has no phone number — confirmation calls cannot be placed." });
  if (!firstName && !lastName) warnings.push({ code: "missing_name", message: "Technician has no name." });
  return {
    companyId,
    externalRef: String(row.inspectpoint_id),
    source: SOURCE,
    firstName,
    lastName,
    email: p.email || null,
    phone,
    isActive: row.is_active !== false,
    additionalInformation: {
      inspectpoint_technician_id: row.inspectpoint_id,
      inspectpoint_name: p.name || null,
      reference_number: p.reference_number || null,
      warnings,
    },
  };
}

/**
 * inspectpoint_jobs -> platform `jobs` (from Inspection).
 *
 * `jobTypeName`, when the caller has one, wins over anything derivable from
 * the payload; otherwise deriveInspectionLabel() works it out from the
 * inspection itself (see that function for why the type field alone can't be
 * relied on).
 */
function normalizeJob(row, { companyId, customerId, locationId, technicianId, primaryContactId = null, jobTypeName = null }) {
  if (!row) return null;
  const p = row.payload || {};
  const { status, warning } = mapJobStatus(row.status_code);
  const warnings = warning ? [warning] : [];
  const label = jobTypeName || deriveInspectionLabel(p);
  return {
    companyId,
    externalRef: String(row.inspectpoint_id),
    source: SOURCE,
    customerId,
    locationId,
    technicianId,
    primaryContactId,
    // Falls back to the external ref — the InspectPoint inspection id, which
    // is also what lands in external_ref — so a job with no resolvable service
    // line or frequency is still identifiable and can be looked up in
    // InspectPoint directly. Deliberately NOT reference_number: that is
    // already carried on its own in jobNumber below, and it is empty on all
    // but a couple of percent of real rows anyway.
    title: label || `Inspection #${row.inspectpoint_id}`,
    // Composed, not copied — InspectPoint has no description field at all.
    description: buildInspectionDescription(p),
    jobType: label,
    status,
    // NOT p.inspection_date (retrospective — when it was actually performed)
    // and NOT start_time/end_time (actual work start/stop) — scheduled_time_iso
    // is the only forward-looking schedule field.
    scheduledDate: tenantLocalDatePrefix(p.scheduled_time_iso),
    scheduledWindowStart: row.scheduled_at || null,
    // From the inspection's own projected_duration_mins — same reasoning as the
    // visit's scheduledEnd: vendor-stated planned length, not an invented one.
    scheduledWindowEnd: addMinutes(row.scheduled_at, p.projected_duration_mins),
    jobNumber: p.reference_number || null,
    externalIds: p.external_id ? { external_id: p.external_id } : {},
    additionalInformation: {
      inspectpoint_inspection_id: row.inspectpoint_id,
      status_code: row.status_code,
      due_date: row.due_date,
      // frequency is a nested OBJECT on the real payload
      // ({id, frequency: "Weekly", frequency_type: "weekly"}) — reading a
      // top-level p.frequency_type silently produced null on every job, which
      // cost the one field this integration was specifically meant to gain
      // over ServiceTrade (deterministic service_line_descriptions matching).
      frequency_type: p.frequency?.frequency_type || null,
      frequency_label: p.frequency?.frequency || null,
      inspection_date: p.inspection_date || null,
      internal_notes: p.internal_notes || null,
      access_message: p.access_message || null,
      warnings,
    },
  };
}

/** inspectpoint_appointments -> platform `appointments` (from Inspection Visit) */
function normalizeAppointment(row, { companyId, jobId, technicianId }) {
  if (!row) return null;
  const p = row.payload || {};
  const warnings = [];
  if (!row.scheduled_date) {
    warnings.push({ code: "missing_scheduled_start", message: "Inspection visit has no scheduled date — inserted as unscheduled, not skipped or synthesized." });
  }
  const durationMins = p.duration_mins ?? null;
  const scheduledStart = row.scheduled_date || null;
  // Resolved once so the warning can travel with the row: an unrecognised visit
  // status lands as "unknown" and must be visible, not swallowed. Pushed onto
  // the SAME warnings array the missing-scheduled-date case already uses, so
  // every normalize concern for this row surfaces in one place.
  const visitStatus = mapVisitStatus(row.visit_status);
  if (visitStatus.warning) warnings.push(visitStatus.warning);
  return {
    companyId,
    externalRef: String(row.inspectpoint_id),
    source: SOURCE,
    jobId,
    technicianId,
    status: visitStatus.status,
    scheduledStart,
    // Derived from the visit's OWN duration_mins, not a guessed default. This
    // is InspectPoint's stated planned length for the visit, so it is real
    // scheduling data rather than a synthetic window — and it is what
    // technician-availability.js and the appointments overlap constraint read
    // to know when a technician is actually free again. Null duration stays
    // null rather than falling back to an invented length; the availability
    // service applies its own documented default in that case.
    scheduledEnd: addMinutes(scheduledStart, durationMins),
    duration: durationMins != null ? durationMins * 60 : null, // seconds — matches ServiceTrade's convention on this column
    additionalInformation: {
      inspectpoint_visit_id: row.inspectpoint_id,
      visit_status: row.visit_status,
      duration_mins: durationMins,
      duration_unit: "seconds",
      visit_notes: p.visit_notes || null,
      external_id: p.external_id || null,
      warnings,
    },
  };
}

module.exports = {
  normalizeDeficiency, normalizeDeficiencyServiceLine,
  buildDeficiencyLabel, cleanDeficiencyLabel, deficiencyAssetType,
  splitPersonName,
  tenantLocalDatePrefix,
  addMinutes,
  deriveInspectionLabel,
  deriveServiceLineName,
  deriveServiceLineRef,
  humanDuration,
  buildInspectionDescription,
  normalizeServiceLine,
  normalizeAppointmentService,
  mapJobStatus,
  mapVisitStatus,
  normalizeCustomer,
  normalizeLocation,
  normalizeContact,
  normalizeTechnician,
  normalizeJob,
  normalizeAppointment,
};
