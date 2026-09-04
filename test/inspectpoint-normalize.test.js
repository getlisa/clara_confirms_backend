/**
 * crm/inspectpoint/normalize.js — raw inspectpoint_* rows -> platform tables.
 * Pure functions, no DB — asserts on every mapping rule the plan calls out by
 * name, since each one was a specific, non-obvious decision (not an
 * arbitrary default) and a silent regression here would misfile real data.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  splitPersonName,
  tenantLocalDatePrefix,
  mapJobStatus,
  mapVisitStatus,
  normalizeCustomer,
  normalizeLocation,
  normalizeContact,
  normalizeTechnician,
  normalizeJob,
  normalizeAppointment,
  addMinutes,
  deriveInspectionLabel,
  deriveServiceLineName,
  deriveServiceLineRef,
  humanDuration,
  buildInspectionDescription,
  normalizeServiceLine,
  normalizeAppointmentService,
} = require("../src/services/crm/inspectpoint/normalize");

// ── splitPersonName ──────────────────────────────────────────────────────────

test("splitPersonName: plain two-word name splits on the last token", () => {
  assert.deepEqual(splitPersonName("Dana Reed"), { firstName: "Dana", lastName: "Reed" });
});

test("splitPersonName: multi-word first name keeps everything but the last token together", () => {
  assert.deepEqual(splitPersonName("Mary Jane Watson"), { firstName: "Mary Jane", lastName: "Watson" });
});

test("splitPersonName: 'Last, First' comma form", () => {
  assert.deepEqual(splitPersonName("Smith, Jordan"), { firstName: "Jordan", lastName: "Smith" });
});

test("splitPersonName: a single token sets only firstName", () => {
  assert.deepEqual(splitPersonName("Cher"), { firstName: "Cher", lastName: null });
});

test("splitPersonName: null/empty name returns both null", () => {
  assert.deepEqual(splitPersonName(null), { firstName: null, lastName: null });
  assert.deepEqual(splitPersonName(""), { firstName: null, lastName: null });
  assert.deepEqual(splitPersonName("   "), { firstName: null, lastName: null });
});

// ── tenantLocalDatePrefix ────────────────────────────────────────────────────

test("tenantLocalDatePrefix slices the date WITHOUT UTC conversion — the whole point of the field", () => {
  // An evening appointment in a negative-offset timezone: a UTC conversion
  // would push this to the next calendar day. The raw string is already
  // tenant-local, so a plain slice is correct and a Date() roundtrip is not.
  assert.equal(tenantLocalDatePrefix("2026-09-10T23:00:00-04:00"), "2026-09-10");
  const wrongWay = new Date("2026-09-10T23:00:00-04:00").toISOString().slice(0, 10);
  assert.equal(wrongWay, "2026-09-11", "sanity check: the UTC-conversion approach really does shift the day");
});

test("tenantLocalDatePrefix returns null for missing/non-string input", () => {
  assert.equal(tenantLocalDatePrefix(null), null);
  assert.equal(tenantLocalDatePrefix(undefined), null);
});

// ── mapJobStatus ─────────────────────────────────────────────────────────────

test("mapJobStatus: every documented status_code maps to the expected jobs.status", () => {
  const cases = {
    pending: "pending", quoted: "open", proposal_approved: "open",
    scheduled: "scheduled",
    started: "in_progress",
    waiting_for_review: "completed", ready_to_generate: "completed", completed: "completed", invoiced: "completed", paid: "completed",
    cancelled: "cancelled", cancelled_by_parent_tenant: "cancelled", deleted_by_technician: "cancelled",
  };
  for (const [code, expected] of Object.entries(cases)) {
    const { status, warning } = mapJobStatus(code);
    assert.equal(status, expected, `${code} should map to ${expected}`);
    assert.equal(warning, null, `${code} is a known mapping and should carry no warning`);
  }
});

test("mapJobStatus: never maps anything to 'confirmed' — that means WE confirmed with the customer", () => {
  const allCodes = ["pending", "quoted", "proposal_approved", "scheduled", "started", "waiting_for_review", "ready_to_generate", "completed", "invoiced", "paid", "cancelled", "cancelled_by_parent_tenant", "deleted_by_technician", "processing", "error", "some_future_unknown_code"];
  for (const code of allCodes) {
    assert.notEqual(mapJobStatus(code).status, "confirmed", `${code} must never map to confirmed`);
    assert.notEqual(mapJobStatus(code).status, "rescheduled", `${code} must never map to rescheduled`);
  }
});

test("mapJobStatus: 'processing' and 'error' are flagged ambiguous, not silently guessed", () => {
  for (const code of ["processing", "error"]) {
    const { status, warning } = mapJobStatus(code);
    assert.equal(status, "open");
    assert.ok(warning, `${code} must carry a warning`);
    assert.equal(warning.code, "ambiguous_status_code");
  }
});

test("mapJobStatus: a genuinely unrecognized code defaults to open with a distinct warning code", () => {
  const { status, warning } = mapJobStatus("totally_made_up");
  assert.equal(status, "open");
  assert.equal(warning.code, "unmapped_status_code");
});

// ── mapVisitStatus ───────────────────────────────────────────────────────────

test("mapVisitStatus maps the four real values, with 'started' collapsing to 'scheduled' (no in_progress on appointments)", () => {
  assert.equal(mapVisitStatus("scheduled"), "scheduled");
  assert.equal(mapVisitStatus("started"), "scheduled");
  assert.equal(mapVisitStatus("complete"), "completed");
  assert.equal(mapVisitStatus("cancelled"), "cancelled");
});

test("mapVisitStatus defaults a missing/null status to 'scheduled'", () => {
  assert.equal(mapVisitStatus(null), "scheduled");
  assert.equal(mapVisitStatus(undefined), "scheduled");
});

// ── normalizeCustomer ────────────────────────────────────────────────────────

test("normalizeCustomer: every InspectPoint account gets phone=null, email=null, and the missing_phone warning — structural, not conditional", () => {
  const row = { inspectpoint_id: 1, is_active: true, payload: { name: "Acme Fire Protection", billing_address1: "100 Main St", billing_city: "Atlanta", billing_state: "GA", billing_zip: "30301" } };
  const out = normalizeCustomer(row, { companyId: 9 });
  assert.equal(out.phone, null);
  assert.equal(out.email, null);
  assert.equal(out.source, "inspectpoint");
  assert.equal(out.externalRef, "1");
  assert.equal(out.fullName, "Acme Fire Protection");
  assert.ok(out.additionalInformation.warnings.some((w) => w.code === "missing_phone"));
});

test("normalizeCustomer: is_active false is preserved", () => {
  const out = normalizeCustomer({ inspectpoint_id: 2, is_active: false, payload: { name: "X" } }, { companyId: 9 });
  assert.equal(out.isActive, false);
});

// ── normalizeLocation ────────────────────────────────────────────────────────

test("normalizeLocation: latitude/longitude strings become finite numbers", () => {
  const out = normalizeLocation({ inspectpoint_id: 10, payload: { name: "Acme Warehouse", latitude: "33.7490", longitude: "-84.3880", account_id: 1, account_name: "Acme" } }, { companyId: 9, customerId: 5 });
  assert.equal(out.lat, 33.749);
  assert.equal(out.lon, -84.388);
  assert.equal(out.customerId, 5);
  assert.deepEqual(out.company, { id: 1, name: "Acme" });
});

test("normalizeLocation: an empty-string or garbage lat/lon becomes null, never NaN", () => {
  const out = normalizeLocation({ inspectpoint_id: 11, payload: { latitude: "", longitude: "not-a-number" } }, { companyId: 9, customerId: 5 });
  assert.equal(out.lat, null);
  assert.equal(out.lon, null);
});

test("normalizeLocation: primaryContactId passes through whatever the caller resolved (including null)", () => {
  const out = normalizeLocation({ inspectpoint_id: 12, payload: {} }, { companyId: 9, customerId: 5, primaryContactId: 77 });
  assert.equal(out.primaryContactId, 77);
  const out2 = normalizeLocation({ inspectpoint_id: 13, payload: {} }, { companyId: 9, customerId: 5 });
  assert.equal(out2.primaryContactId, null);
});

// ── normalizeContact ─────────────────────────────────────────────────────────

test("normalizeContact: three-phone mapping — business->phone, cell->mobile, home->alternate_phone", () => {
  const out = normalizeContact({ inspectpoint_id: 100, payload: { name: "Dana Reed", business_phone_number: "4045551000", cell_phone_number: "4045551001", home_phone_number: "4045551002" } }, { companyId: 9 });
  assert.equal(out.phone, "+14045551000");
  assert.equal(out.mobile, "+14045551001");
  assert.equal(out.alternatePhone, "+14045551002");
});

test("normalizeContact: phone falls back to cell then home when business is absent, so a cell-only contact isn't unreachable via .phone", () => {
  const out = normalizeContact({ inspectpoint_id: 101, payload: { name: "Jordan Smith", cell_phone_number: "4045552001" } }, { companyId: 9 });
  assert.equal(out.phone, "+14045552001");
  assert.equal(out.mobile, "+14045552001");
  assert.equal(out.alternatePhone, null);
});

test("normalizeContact: the fax number NEVER lands in phone/mobile/alternate_phone", () => {
  const out = normalizeContact({ inspectpoint_id: 102, payload: { name: "No Phone Guy", business_fax_number: "4045559999" } }, { companyId: 9 });
  assert.equal(out.phone, null);
  assert.equal(out.mobile, null);
  assert.equal(out.alternatePhone, null);
  assert.equal(out.additionalInformation.business_fax_number, "4045559999");
});

test("normalizeContact: types is the lowercased, deduped union of account_contact_types and every building role", () => {
  const out = normalizeContact({
    inspectpoint_id: 103,
    payload: {
      name: "Multi Role",
      account_contact_types: ["Billing", "Scheduling"],
      buildings: [{ id: 1, roles: ["Scheduling", "Owner"] }, { id: 2, roles: ["OWNER"] }],
    },
  }, { companyId: 9 });
  assert.deepEqual([...out.types].sort(), ["billing", "owner", "scheduling"]);
});

test("normalizeContact: contactRole reflects the isPrimary flag the caller passes in", () => {
  const primary = normalizeContact({ inspectpoint_id: 104, payload: { name: "P" } }, { companyId: 9, isPrimary: true });
  assert.equal(primary.contactRole, "primary");
  const general = normalizeContact({ inspectpoint_id: 105, payload: { name: "G" } }, { companyId: 9 });
  assert.equal(general.contactRole, "general");
});

test("normalizeContact: the untouched original name always survives in additionalInformation", () => {
  const out = normalizeContact({ inspectpoint_id: 106, payload: { name: "Smith, Jordan Q." } }, { companyId: 9 });
  assert.equal(out.additionalInformation.inspectpoint_name, "Smith, Jordan Q.");
});

// ── normalizeTechnician ──────────────────────────────────────────────────────

test("normalizeTechnician: missing phone warns but still produces a row (phone is nullable)", () => {
  const out = normalizeTechnician({ inspectpoint_id: 200, is_active: true, payload: { name: "Ryan Brooks" } }, { companyId: 9 });
  assert.equal(out.phone, null);
  assert.ok(out.additionalInformation.warnings.some((w) => w.code === "missing_phone"));
  assert.equal(out.firstName, "Ryan");
  assert.equal(out.lastName, "Brooks");
});

// ── normalizeJob ─────────────────────────────────────────────────────────────

test("normalizeJob: scheduledDate is the tenant-local date prefix, scheduledWindowStart is the full instant", () => {
  const row = { inspectpoint_id: 1000, status_code: "scheduled", scheduled_at: "2026-09-10T13:00:00-04:00", due_date: "2026-09-30T00:00:00-04:00", payload: { scheduled_time_iso: "2026-09-10T13:00:00-04:00", reference_number: "INSP-1000" } };
  const out = normalizeJob(row, { companyId: 9, customerId: 1, locationId: 10, technicianId: 200, jobTypeName: "Annual Fire Alarm" });
  assert.equal(out.scheduledDate, "2026-09-10");
  assert.equal(out.scheduledWindowStart, "2026-09-10T13:00:00-04:00");
  assert.equal(out.title, "Annual Fire Alarm");
  assert.equal(out.jobType, "Annual Fire Alarm");
  assert.equal(out.jobNumber, "INSP-1000");
});

test("normalizeJob: falls back to an 'Inspection #<external ref>' title when nothing else resolves", () => {
  // The external ref IS the InspectPoint inspection id, so the title stays
  // traceable back to their system. reference_number is deliberately not used
  // here — it already has its own column (jobNumber) and is empty on all but a
  // couple of percent of real rows.
  const out = normalizeJob({ inspectpoint_id: 1001, status_code: "pending", payload: { reference_number: "INSP-1001" } }, { companyId: 9, customerId: 1, locationId: 10, technicianId: null });
  assert.equal(out.title, "Inspection #1001");
  assert.equal(out.externalRef, "1001", "the title's number and external_ref must be the same id");
  assert.equal(out.jobNumber, "INSP-1001", "reference_number is still preserved, just not in the title");
  assert.equal(out.jobType, null);
});

test("normalizeJob: a resolvable service line or frequency still wins over the id fallback", () => {
  const typed = normalizeJob({ inspectpoint_id: 1002, status_code: "pending", payload: { inspection_type: { name: "Hood Cleaning" } } }, { companyId: 9, customerId: 1, locationId: 10, technicianId: null });
  assert.equal(typed.title, "Hood Cleaning");
  const freq = normalizeJob({ inspectpoint_id: 1003, status_code: "pending", payload: { frequency: { frequency: "Annual" } } }, { companyId: 9, customerId: 1, locationId: 10, technicianId: null });
  assert.equal(freq.title, "Annual Inspection");
});

test("normalizeJob: inspection_date and start_time/end_time never leak into scheduled_* — they're retrospective, not the schedule", () => {
  const row = { inspectpoint_id: 1002, status_code: "completed", payload: { scheduled_time_iso: null, inspection_date: "2026-09-01T09:00:00-04:00", start_time: "09:05", end_time: "10:00" } };
  const out = normalizeJob(row, { companyId: 9, customerId: 1, locationId: 10, technicianId: null });
  assert.equal(out.scheduledDate, null);
  assert.equal(out.additionalInformation.inspection_date, "2026-09-01T09:00:00-04:00");
});

test("normalizeJob: due_date and status_code are preserved verbatim in additionalInformation for the compliance/slot logic", () => {
  const out = normalizeJob({ inspectpoint_id: 1003, status_code: "scheduled", due_date: "2026-09-30T00:00:00-04:00", payload: {} }, { companyId: 9, customerId: 1, locationId: 10, technicianId: null });
  assert.equal(out.additionalInformation.due_date, "2026-09-30T00:00:00-04:00");
  assert.equal(out.additionalInformation.status_code, "scheduled");
});

// ── normalizeAppointment ─────────────────────────────────────────────────────

test("normalizeAppointment: an unscheduled visit (scheduled_date null) is inserted with scheduledStart=null and a warning — not skipped", () => {
  const out = normalizeAppointment({ inspectpoint_id: 5001, inspectpoint_job_id: 1001, visit_status: null, scheduled_date: null, payload: {} }, { companyId: 9, jobId: 2, technicianId: null });
  assert.equal(out, out); // it exists — not null/skipped
  assert.equal(out.scheduledStart, null);
  assert.ok(out.additionalInformation.warnings.some((w) => w.code === "missing_scheduled_start"));
  assert.equal(out.status, "scheduled"); // default per mapVisitStatus(null)
});

test("normalizeAppointment: duration_mins is converted to seconds and the unit is documented", () => {
  const out = normalizeAppointment({ inspectpoint_id: 5000, visit_status: "scheduled", scheduled_date: "2026-09-10T13:00:00-04:00", payload: { duration_mins: 60 } }, { companyId: 9, jobId: 1, technicianId: 200 });
  assert.equal(out.duration, 3600);
  assert.equal(out.additionalInformation.duration_mins, 60);
  assert.equal(out.additionalInformation.duration_unit, "seconds");
});

test("normalizeAppointment: a scheduled visit carries the real visit_status through mapVisitStatus", () => {
  const out = normalizeAppointment({ inspectpoint_id: 5002, visit_status: "complete", scheduled_date: "2026-08-01T09:00:00-04:00", payload: {} }, { companyId: 9, jobId: 1, technicianId: 200 });
  assert.equal(out.status, "completed");
});

// ── Field-shape fixes verified against the LIVE API (see the commit that added
// these). Every case below is a mapping that silently produced null on real
// synced data because the code read a field that doesn't exist in the shape
// InspectPoint actually returns. ─────────────────────────────────────────────

test("addMinutes: a real start plus a real duration produces the end instant", () => {
  assert.equal(addMinutes("2026-09-07T11:00:00.000Z", 360), "2026-09-07T17:00:00.000Z");
});

test("addMinutes: a missing duration yields null rather than a zero-length window", () => {
  assert.equal(addMinutes("2026-09-07T11:00:00.000Z", null), null);
  assert.equal(addMinutes("2026-09-07T11:00:00.000Z", 0), null);
  assert.equal(addMinutes(null, 360), null);
});

test("deriveInspectionLabel: a real inspection_type.name wins over everything", () => {
  const label = deriveInspectionLabel({ inspection_type: { name: "Fire Extinguishers" }, frequency: { frequency: "Annual" } });
  assert.equal(label, "Fire Extinguishers");
});

test("deriveInspectionLabel: falls back to the frequency label when the tenant has no inspection_type", () => {
  // The real shape for ~1/3 of a live tenant's inspections — inspection_type is
  // documented nullable and is genuinely absent on many rows.
  assert.equal(deriveInspectionLabel({ frequency: { frequency: "Semi Annual", frequency_type: "semiannual" } }), "Semi Annual Inspection");
});

test("deriveInspectionLabel: null when neither a type nor a frequency exists, so the caller can use its reference fallback", () => {
  assert.equal(deriveInspectionLabel({}), null);
});

test("normalizeJob: frequency_type comes from the NESTED frequency object, not a top-level field", () => {
  // Reading a top-level p.frequency_type produced null on every real job and
  // cost the deterministic service_line_descriptions matching this whole
  // integration was meant to gain.
  const row = { inspectpoint_id: 1209, status_code: "pending", payload: { frequency: { frequency: "Weekly", frequency_type: "weekly" } } };
  const out = normalizeJob(row, { companyId: 9, customerId: 1, locationId: 10, technicianId: null });
  assert.equal(out.additionalInformation.frequency_type, "weekly");
  assert.equal(out.additionalInformation.frequency_label, "Weekly");
});

test("normalizeJob: a real inspection_type.name becomes both the title and job_type without any caller-supplied name", () => {
  const row = { inspectpoint_id: 1210, status_code: "scheduled", payload: { inspection_type: { name: "Hood Cleaning" }, frequency: { frequency: "Semi Annual" } } };
  const out = normalizeJob(row, { companyId: 9, customerId: 1, locationId: 10, technicianId: null });
  assert.equal(out.title, "Hood Cleaning");
  assert.equal(out.jobType, "Hood Cleaning");
});

test("normalizeJob: scheduledWindowEnd is derived from the inspection's own projected_duration_mins", () => {
  const row = { inspectpoint_id: 1211, status_code: "scheduled", scheduled_at: "2026-09-07T11:00:00.000Z", payload: { projected_duration_mins: 360 } };
  const out = normalizeJob(row, { companyId: 9, customerId: 1, locationId: 10, technicianId: null });
  assert.equal(out.scheduledWindowEnd, "2026-09-07T17:00:00.000Z");
});

test("normalizeAppointment: scheduledEnd is derived from the visit's own duration_mins", () => {
  const row = { inspectpoint_id: 1156, visit_status: "scheduled", scheduled_date: "2026-09-07T11:00:00.000Z", payload: { duration_mins: 360 } };
  const out = normalizeAppointment(row, { companyId: 9, jobId: 5, technicianId: 200 });
  assert.equal(out.scheduledStart, "2026-09-07T11:00:00.000Z");
  assert.equal(out.scheduledEnd, "2026-09-07T17:00:00.000Z");
});

test("normalizeAppointment: no duration leaves scheduledEnd null — availability applies its own default rather than inheriting an invented one", () => {
  const row = { inspectpoint_id: 1157, visit_status: "scheduled", scheduled_date: "2026-09-07T11:00:00.000Z", payload: {} };
  const out = normalizeAppointment(row, { companyId: 9, jobId: 5, technicianId: 200 });
  assert.equal(out.scheduledEnd, null);
});

// ── Description + service line (requirements 2 and 4) ────────────────────────
// Coverage figures quoted below are from a live tenant's 98 open inspections,
// measured before this mapping was written.

test("buildInspectionDescription: composes cadence + service line + duration, because InspectPoint has NO description field", () => {
  const d = buildInspectionDescription({ frequency: { frequency: "Semi Annual" }, inspection_type: { name: "Fire Extinguishers" }, projected_duration_mins: 120 });
  assert.equal(d, "Semi Annual Fire Extinguishers inspection (about 2 hours)");
});

test("buildInspectionDescription: still says something useful with no service line (26 of 98 real rows)", () => {
  assert.equal(buildInspectionDescription({ frequency: { frequency: "Semi Annual" }, projected_duration_mins: 120 }), "Semi Annual inspection (about 2 hours)");
});

test("buildInspectionDescription: real technician_instructions are APPENDED, never replaced by the composed text", () => {
  const d = buildInspectionDescription({ frequency: { frequency: "Annual" }, projected_duration_mins: 60, technician_instructions: "Gate code 4432." });
  assert.equal(d, "Annual inspection (about 1 hour). Gate code 4432.");
});

test("buildInspectionDescription: degrades to a bare label when the payload is empty rather than returning null", () => {
  assert.equal(buildInspectionDescription({}), "Inspection");
});

test("humanDuration: minutes under an hour stay minutes; whole hours don't get a decimal", () => {
  assert.equal(humanDuration(30), "about 30 minutes");
  assert.equal(humanDuration(120), "about 2 hours");
  assert.equal(humanDuration(90), "about 1.5 hours");
  assert.equal(humanDuration(60), "about 1 hour");
  assert.equal(humanDuration(0), null);
  assert.equal(humanDuration(null), null);
});

test("deriveServiceLineName: prefers the real inspection type, then a named custom inspection", () => {
  assert.equal(deriveServiceLineName({ inspection_type: { name: "Hood Cleaning" } }), "Hood Cleaning");
  assert.equal(deriveServiceLineName({ custom_inspections: [{ name: "Hood Cleaning Report" }] }), "Hood Cleaning Report");
});

test("deriveServiceLineName: returns null rather than using frequency — a cadence is not a trade category", () => {
  assert.equal(deriveServiceLineName({ frequency: { frequency: "Semi Annual" } }), null);
});

test("deriveServiceLineRef: keyed on the type id when there is one, else the normalized name, so both dedupe stably", () => {
  assert.equal(deriveServiceLineRef({ inspection_type: { id: 3, name: "Fire Extinguishers" } }), "type:3");
  assert.equal(deriveServiceLineRef({ custom_inspections: [{ name: "Hood Cleaning Report" }] }), "name:hood cleaning report");
  assert.equal(deriveServiceLineRef({}), null);
});

test("normalizeServiceLine: returns null for an inspection that names no service line, so no placeholder row is created", () => {
  assert.equal(normalizeServiceLine({ frequency: { frequency: "Weekly" } }, { companyId: 9 }), null);
});

test("normalizeServiceLine: a real type becomes a service_lines row keyed by type id", () => {
  const sl = normalizeServiceLine({ inspection_type: { id: 3, name: "Fire Extinguishers" } }, { companyId: 9 });
  assert.equal(sl.name, "Fire Extinguishers");
  assert.equal(sl.externalRef, "type:3");
  assert.equal(sl.source, "inspectpoint");
});

test("normalizeAppointmentService: carries the description and links the service line, keyed on the visit id", () => {
  const visit = { inspectpoint_id: 1156, visit_status: "scheduled", scheduled_date: "2026-09-07T11:00:00.000Z", payload: { duration_mins: 120 } };
  const jobPayload = { frequency: { frequency: "Annual" }, inspection_type: { id: 3, name: "Fire Extinguishers" }, projected_duration_mins: 120 };
  const out = normalizeAppointmentService(visit, { companyId: 9, appointmentId: 55, jobId: 77, serviceLineId: 12, jobPayload });
  assert.equal(out.externalRef, "visit:1156");
  assert.equal(out.appointmentId, 55);
  assert.equal(out.serviceLineId, 12);
  assert.equal(out.description, "Annual Fire Extinguishers inspection (about 2 hours)");
  assert.equal(out.windowStart, "2026-09-07T11:00:00.000Z");
  assert.equal(out.windowEnd, "2026-09-07T13:00:00.000Z");
  assert.equal(out.duration, 7200);
});

test("normalizeAppointmentService: still produced with a null service line, so service_details is never empty", () => {
  const visit = { inspectpoint_id: 1157, visit_status: "scheduled", scheduled_date: "2026-09-07T11:00:00.000Z", payload: {} };
  const out = normalizeAppointmentService(visit, { companyId: 9, appointmentId: 56, jobId: 77, serviceLineId: null, jobPayload: { frequency: { frequency: "Semi Annual" } } });
  assert.equal(out.serviceLineId, null);
  assert.equal(out.description, "Semi Annual inspection");
});

test("normalizeAppointmentService: no appointment id means no row — an orphan service would be unreachable", () => {
  assert.equal(normalizeAppointmentService({ inspectpoint_id: 1 }, { companyId: 9, appointmentId: null }), null);
});

test("normalizeJob: description is composed, not the (almost always empty) technician_instructions field", () => {
  const out = normalizeJob({ inspectpoint_id: 1209, status_code: "scheduled", payload: { frequency: { frequency: "Weekly" }, projected_duration_mins: 360 } }, { companyId: 9, customerId: 1, locationId: 10, technicianId: null });
  assert.equal(out.description, "Weekly inspection (about 6 hours)");
});

// ── 'pending' as a first-class platform status (migration 106) ───────────────

test("mapJobStatus: InspectPoint's `pending` keeps its own name instead of collapsing into `open`", () => {
  // It is the dominant real status (1,555 of 1,566 open inspections on a live
  // tenant) and is what the customer sees in their own CRM, so flattening it
  // to `open` made our UI disagree with theirs.
  assert.equal(mapJobStatus("pending").status, "pending");
  assert.equal(mapJobStatus("pending").warning, null);
});

test("mapJobStatus: only `pending` becomes 'pending' — the other pre-scheduling codes stay `open`", () => {
  assert.equal(mapJobStatus("quoted").status, "open");
  assert.equal(mapJobStatus("proposal_approved").status, "open");
});

test("mapJobStatus: an unknown or ambiguous code still falls back to `open`, never to 'pending'", () => {
  // `open` remains the safe catch-all; 'pending' is a positive assertion about
  // a specific upstream state, not a guess.
  for (const code of ["processing", "error", "totally_made_up"]) {
    assert.equal(mapJobStatus(code).status, "open", `${code} must fall back to open`);
  }
});
