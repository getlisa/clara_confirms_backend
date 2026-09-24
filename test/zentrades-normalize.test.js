/**
 * services/crm/zentrades/normalize.js — pure mapping functions. No db, no
 * network. Heaviest coverage on the two genuinely novel problems this CRM
 * has that neither ServiceTrade nor InspectPoint does: the "Open" status
 * collision (mapJobStatus) and merging three synthetic contact "kinds" that
 * can all be the same real person (dedupeContactsByEmail).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const normalize = require("../src/services/crm/zentrades/normalize");

// ── mapJobStatus — the "Open" collision fix ─────────────────────────────────

function ticketRow(overrides = {}) {
  return {
    zentrades_id: 1924543,
    job_status_id: 1,
    job_status: "Open",
    payload: { isActive: true, isDeleted: false, assignments: [], ...overrides.payload },
    ...overrides,
  };
}

test("mapJobStatus: Open with a live assignment maps to 'scheduled', NOT 'open'", () => {
  const row = ticketRow({ payload: { assignments: [{ isActive: true, isDeleted: false, startTime: "2026-09-14T13:15:00.000Z" }] } });
  const { status, warning } = normalize.mapJobStatus(row);
  assert.equal(status, "scheduled");
  assert.equal(warning, null);
});

test("mapJobStatus: Open with NO live assignment maps to 'open' — genuinely unscheduled", () => {
  const row = ticketRow({ payload: { assignments: [] } });
  const { status } = normalize.mapJobStatus(row);
  assert.equal(status, "open");
});

test("mapJobStatus: matches on the STRING label, not the numeric jobStatusId — jobStatusId is per-tenant configuration (regression: company 13/Element Fire uses 1988 for 'Open', not 1)", () => {
  const row = ticketRow({ job_status_id: 1988, job_status: "Open", payload: { assignments: [{ isActive: true, isDeleted: false, startTime: "2026-09-14T13:15:00.000Z" }] } });
  const { status, warning } = normalize.mapJobStatus(row);
  assert.equal(status, "scheduled", "a live assignment must still be recognized regardless of this tenant's numeric jobStatusId");
  assert.equal(warning, null);
});

test("mapJobStatus: the 'Open' label match is case-insensitive", () => {
  const row = ticketRow({ job_status: "OPEN", payload: { assignments: [] } });
  assert.equal(normalize.mapJobStatus(row).status, "open");
});

test("mapJobStatus: an assignment with no startTime does not count as live", () => {
  const row = ticketRow({ payload: { assignments: [{ isActive: true, isDeleted: false, startTime: null }] } });
  assert.equal(normalize.mapJobStatus(row).status, "open");
});

test("mapJobStatus: a deleted or inactive assignment does not count as live", () => {
  const deleted = ticketRow({ payload: { assignments: [{ isActive: true, isDeleted: true, startTime: "2026-09-14T13:15:00.000Z" }] } });
  const inactive = ticketRow({ payload: { assignments: [{ isActive: false, isDeleted: false, startTime: "2026-09-14T13:15:00.000Z" }] } });
  assert.equal(normalize.mapJobStatus(deleted).status, "open");
  assert.equal(normalize.mapJobStatus(inactive).status, "open");
});

test("mapJobStatus: isDeleted/isActive:false on the TICKET itself is authoritative — cancelled regardless of assignments", () => {
  const row = ticketRow({ payload: { isDeleted: true, assignments: [{ isActive: true, isDeleted: false, startTime: "2026-09-14T13:15:00.000Z" }] } });
  assert.equal(normalize.mapJobStatus(row).status, "cancelled");
});

test("mapJobStatus: an unrecognized jobStatus label defaults to 'open' with a warning, never guesses another status", () => {
  const row = ticketRow({ job_status: "Completed" });
  const { status, warning } = normalize.mapJobStatus(row);
  assert.equal(status, "open");
  assert.equal(warning.code, "unmapped_job_status");
  assert.match(warning.message, /Completed/);
});

test("mapJobStatus never produces 'pending' — that is InspectPoint's word, not ZenTrades'", () => {
  const row = ticketRow({ payload: { assignments: [] } });
  assert.notEqual(normalize.mapJobStatus(row).status, "pending");
});

// ── ticketHasLiveAssignment ──────────────────────────────────────────────────

test("ticketHasLiveAssignment is false for an empty or missing assignments array", () => {
  assert.equal(normalize.ticketHasLiveAssignment({}), false);
  assert.equal(normalize.ticketHasLiveAssignment({ assignments: [] }), false);
});

test("ticketHasLiveAssignment is true when at least one assignment is live, even alongside dead ones", () => {
  const payload = {
    assignments: [
      { isActive: false, isDeleted: false, startTime: "2026-09-14T13:15:00.000Z" },
      { isActive: true, isDeleted: false, startTime: "2026-09-15T09:00:00.000Z" },
    ],
  };
  assert.equal(normalize.ticketHasLiveAssignment(payload), true);
});

// ── mapAssignmentStatus ──────────────────────────────────────────────────────

test("mapAssignmentStatus: deleted/inactive -> cancelled, otherwise scheduled (ZenTrades' own status vocabulary beyond Open is unverified)", () => {
  assert.equal(normalize.mapAssignmentStatus({ payload: { isDeleted: true } }), "cancelled");
  assert.equal(normalize.mapAssignmentStatus({ payload: { isActive: false } }), "cancelled");
  assert.equal(normalize.mapAssignmentStatus({ payload: { isActive: true, isDeleted: false } }), "scheduled");
});

// ── dedupeContactsByEmail ────────────────────────────────────────────────────

function contactRow(zentradesId, kind, payload, extra = {}) {
  // Matches production's normalizeEmail() in services/zentrades-sync.js —
  // email_lower is trimmed AND lowercased when the raw row is written.
  const emailLower = payload.email ? String(payload.email).trim().toLowerCase() : null;
  return { zentrades_id: zentradesId, contact_kind: kind, email_lower: emailLower, payload, ...extra };
}

test("dedupeContactsByEmail merges customer + service_address rows sharing an email into ONE canonical row", () => {
  const rows = [
    contactRow("cust:368", "customer", { email: "Sandeep@Smartserv.io", displayName: "Nov Com12" }),
    contactRow("addr:418", "service_address", { email: "sandeep@smartserv.io", firstname: "28thh", lastname: "November" }),
  ];
  const { canonicalRows, alias } = normalize.dedupeContactsByEmail(rows);
  assert.equal(canonicalRows.length, 1, "two rows, same email (case-insensitive) -> one canonical contact");
  // service_address wins canonical (kind priority) over customer.
  assert.equal(canonicalRows[0].zentrades_id, "addr:418");
  assert.equal(alias.get("cust:368"), "addr:418");
  assert.equal(alias.get("addr:418"), "addr:418");
});

test("dedupeContactsByEmail fills the canonical row's blank fields from the merged duplicate", () => {
  const rows = [
    contactRow("addr:418", "service_address", { email: "sandeep@smartserv.io", firstname: null, lastname: null }),
    contactRow("cust:368", "customer", { email: "sandeep@smartserv.io", firstname: "28thh", lastname: "November", displayName: "Nov Com12" }),
  ];
  const { canonicalRows } = normalize.dedupeContactsByEmail(rows);
  assert.equal(canonicalRows[0].zentrades_id, "addr:418");
  assert.equal(canonicalRows[0].payload.firstname, "28thh", "blank canonical field filled from the duplicate");
  assert.equal(canonicalRows[0].payload.displayName, "Nov Com12");
});

test("dedupeContactsByEmail never overwrites a canonical field that's already set, even with a duplicate's non-blank value", () => {
  const rows = [
    contactRow("addr:418", "service_address", { email: "x@y.test", firstname: "Real" }),
    contactRow("cust:368", "customer", { email: "x@y.test", firstname: "Different" }),
  ];
  const { canonicalRows } = normalize.dedupeContactsByEmail(rows);
  assert.equal(canonicalRows[0].payload.firstname, "Real");
});

test("dedupeContactsByEmail leaves contacts with NO email as distinct rows — never grouped together", () => {
  const rows = [
    contactRow("ac:28", "additional", { name: "abc", email: null }),
    contactRow("ac:29", "additional", { name: "def", email: null }),
  ];
  const { canonicalRows, alias } = normalize.dedupeContactsByEmail(rows);
  assert.equal(canonicalRows.length, 2);
  assert.equal(alias.get("ac:28"), "ac:28");
  assert.equal(alias.get("ac:29"), "ac:29");
});

test("dedupeContactsByEmail is case-insensitive and trims whitespace on the email key", () => {
  const rows = [
    contactRow("addr:1", "service_address", { email: "  Test@Example.com  " }),
    contactRow("cust:2", "customer", { email: "test@example.com" }),
  ];
  const { canonicalRows } = normalize.dedupeContactsByEmail(rows);
  assert.equal(canonicalRows.length, 1);
});

test("dedupeContactsByEmail with three-way duplicates (customer + service_address + additional) collapses to one, service_address canonical", () => {
  const rows = [
    contactRow("cust:1", "customer", { email: "shared@x.test" }),
    contactRow("ac:2", "additional", { email: "shared@x.test" }),
    contactRow("addr:3", "service_address", { email: "shared@x.test" }),
  ];
  const { canonicalRows, alias } = normalize.dedupeContactsByEmail(rows);
  assert.equal(canonicalRows.length, 1);
  assert.equal(canonicalRows[0].zentrades_id, "addr:3");
  assert.equal(alias.get("cust:1"), "addr:3");
  assert.equal(alias.get("ac:2"), "addr:3");
});

// ── normalizeContact — the 'additional' kind needs name-splitting ───────────

test("normalizeContact splits a single `name` field for an 'additional' contact with no firstname/lastname", () => {
  const row = { zentrades_id: "ac:28", contact_kind: "additional", payload: { name: "Jane Smith", email: "jane@x.test" } };
  const contact = normalize.normalizeContact(row, { companyId: 1 });
  assert.equal(contact.firstName, "Jane");
  assert.equal(contact.lastName, "Smith");
});

test("normalizeContact prefers real firstname/lastname over splitting `name` when both are present", () => {
  const row = { zentrades_id: "cust:1", contact_kind: "customer", payload: { firstname: "Real", lastname: "Name", name: "Something Else" } };
  const contact = normalize.normalizeContact(row, { companyId: 1 });
  assert.equal(contact.firstName, "Real");
  assert.equal(contact.lastName, "Name");
});

test("normalizeContact marks isPrimary as contactRole 'primary', otherwise 'general'", () => {
  const row = { zentrades_id: "addr:1", contact_kind: "service_address", payload: {} };
  assert.equal(normalize.normalizeContact(row, { companyId: 1, isPrimary: true }).contactRole, "primary");
  assert.equal(normalize.normalizeContact(row, { companyId: 1, isPrimary: false }).contactRole, "general");
});

// ── normalizeCustomer / normalizeLocation ────────────────────────────────────

test("normalizeCustomer never surfaces billingAddress fields — it was stripped at raw sync time and there is nowhere for it to leak from", () => {
  const row = { zentrades_id: 368, is_active: true, payload: { displayName: "Nov Com12", email: "x@y.test", landline: "(123) 456-7890" } };
  const customer = normalize.normalizeCustomer(row, { companyId: 1 });
  assert.equal(customer.addressLine1, null);
  assert.equal(JSON.stringify(customer).includes("billingAddress"), false);
});

test("normalizeCustomer derives phone from landline first, falling back to cellphone", () => {
  const withLandline = normalize.normalizeCustomer({ zentrades_id: 1, payload: { landline: "(123) 456-7890" } }, { companyId: 1 });
  assert.equal(withLandline.phone, "+11234567890");
  const cellOnly = normalize.normalizeCustomer({ zentrades_id: 2, payload: { cellphone: "(348) 324-8122" } }, { companyId: 1 });
  assert.equal(cellOnly.phone, "+13483248122");
});

test("normalizeLocation records do_not_serve in additionalInformation (no platform column exists yet — see this function's KNOWN GAP doc)", () => {
  const row = { zentrades_id: 418, do_not_serve: true, is_active: true, payload: {} };
  const location = normalize.normalizeLocation(row, { companyId: 1, customerId: null });
  assert.equal(location.additionalInformation.do_not_serve, true);
});

// ── normalizeJob — title/description fallback chain ─────────────────────────

test("deriveJobTitle prefers a real jobDescription, then jobType + ticket number, then bare ticket number", () => {
  assert.equal(normalize.deriveJobTitle({ jobDescription: "Fix the thing" }, "009670"), "Fix the thing");
  assert.equal(normalize.deriveJobTitle({ jobDescription: "" , jobType: "AC Repair" }, "009670"), "AC Repair — Ticket #009670");
  assert.equal(normalize.deriveJobTitle({}, "009670"), "Ticket #009670");
});

test("normalizeJob's scheduledDate is derived from the ticket's own scheduled_start, not left null when a window exists", () => {
  const row = { zentrades_id: 1, job_status_id: 1, ticket_number: "1", scheduled_start: "2026-09-14T13:15:00.000Z", scheduled_end: "2026-09-14T15:15:00.000Z", payload: {} };
  const job = normalize.normalizeJob(row, { companyId: 1, customerId: null, locationId: null });
  assert.equal(job.scheduledDate, "2026-09-14");
  assert.equal(job.scheduledWindowStart, row.scheduled_start);
  assert.equal(job.scheduledWindowEnd, row.scheduled_end);
});

test("REGRESSION: normalizeJob's scheduledDate is correct even when scheduled_start is a real JS Date object, not an ISO string — this is what node-postgres actually returns for a TIMESTAMPTZ column", () => {
  // Live failure this reproduces: INSERT INTO jobs ... failed with
  // 'invalid input syntax for type date: "Sun Sep 13"' — String(dateObject)
  // calls Date.prototype.toString(), not toISOString(). toDateOnly() (used
  // internally by normalizeJob) must handle a Date object correctly.
  const row = {
    zentrades_id: 2, job_status_id: 1, ticket_number: "2",
    scheduled_start: new Date("2026-09-14T13:15:00.000Z"),
    scheduled_end: new Date("2026-09-14T15:15:00.000Z"),
    payload: {},
  };
  const job = normalize.normalizeJob(row, { companyId: 1, customerId: null, locationId: null });
  assert.equal(job.scheduledDate, "2026-09-14");
  assert.doesNotMatch(job.scheduledDate, /[A-Za-z]/, "must be a plain YYYY-MM-DD string, never Date.toString()'s weekday/month text");
});

test("toDateOnly handles a Date object, an ISO string, and a falsy/invalid value", () => {
  assert.equal(normalize.toDateOnly(new Date("2026-09-14T13:15:00.000Z")), "2026-09-14");
  assert.equal(normalize.toDateOnly("2026-09-14T13:15:00.000Z"), "2026-09-14");
  assert.equal(normalize.toDateOnly(null), null);
  assert.equal(normalize.toDateOnly(undefined), null);
  assert.equal(normalize.toDateOnly("not-a-date"), null, "an unparseable value must not throw or silently insert garbage");
});

// ── normalizeAppointment ─────────────────────────────────────────────────────

test("normalizeAppointment computes duration in seconds from scheduled_start/end", () => {
  const row = { zentrades_id: 2790843, scheduled_start: "2026-09-14T13:15:00.000Z", scheduled_end: "2026-09-14T15:15:00.000Z", payload: {} };
  const appt = normalize.normalizeAppointment(row, { companyId: 1, jobId: 1, technicianId: 1 });
  assert.equal(appt.duration, 7200);
});

test("normalizeAppointment warns (but still inserts) when there is no scheduled_start at all", () => {
  const row = { zentrades_id: 2790843, scheduled_start: null, scheduled_end: null, payload: {} };
  const appt = normalize.normalizeAppointment(row, { companyId: 1, jobId: 1, technicianId: null });
  assert.equal(appt.scheduledStart, null);
  assert.equal(appt.additionalInformation.warnings[0].code, "missing_scheduled_start");
});
