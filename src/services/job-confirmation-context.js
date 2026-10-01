/**
 * Job-centric confirmation context — ONE definition of "what is this job's
 * confirmation state", feeding every surface that needs it:
 *
 *   the get_appointments tool  (routes/retell-tools.js) — appointment data
 *   voice dynamic variables    (services/scheduler.js runDispatcher) — job data
 *   chat dynamic variables     (services/chat-links.js buildDynamicVariables)
 *   confirmation eligibility   (services/call-hydration.js)
 *
 * They used to each derive their own view of "the appointment", which is how the
 * agent ended up talking about a job as though it were a single appointment.
 *
 * The split matters: **job details are injected into the prompt, appointment
 * data is only ever fetched via the tool.** Retell binds dynamic variables once
 * at call/chat creation, so appointment facts placed there would be a snapshot
 * that goes stale mid-conversation — see toDynamicVariables vs
 * toAppointmentsPayload below.
 *
 * A confirmation conversation is about a JOB. A job has several appointments —
 * separate visits, sometimes different services and technicians, some already
 * done. The agent leads with the NEXT upcoming one and offers to confirm the
 * rest before hanging up.
 */

const jobsDb = require("../db/jobs");
const db = require("../db");
const { getCompanyTimezone, formatSpokenDateTime, formatSpokenDateOnly, formatArrivalWindow } = require("../utils/timezone");
const logger = require("../utils/logger");

/**
 * An appointment is "upcoming" if it hasn't happened yet and hasn't been called
 * off. `confirmed` counts: it's still a visit the customer expects, we just
 * won't re-ask about it. `rescheduled` counts because a moved appointment still
 * needs confirming at its new time — and excluding it is why the old
 * `status === 'scheduled'` check made mid-conversation reschedules vanish.
 */
const UPCOMING_STATUSES = ["scheduled", "confirmed", "rescheduled"];

// The node instruction is re-sent on every conversation turn, so anything that
// rides in a dynamic variable is paid for repeatedly — hence only a couple of
// short job-level values go there. Appointment lists ride on the
// get_appointments tool result instead, which is charged once per call.
const MAX_COMMENTS = 3;
const MAX_COMMENT_CHARS = 500;
const MAX_PAST_APPOINTMENTS = 5;

// How long after the scheduled start a crew may realistically arrive.
// The window runs FORWARD from the scheduled time — an 8 AM visit is
// "between 8 AM and 9 AM" — rather than straddling it, which would have told
// the customer the crew might arrive before the time they were given.
const ARRIVAL_WINDOW_MINUTES = 60;

/** Distinct, non-empty, order-preserving. */
// One site in the live tenant has 29 open deficiencies; the median is 3.
// Five is enough to be concrete without turning the call into a list.
const MAX_SPOKEN_DEFICIENCIES = 5;

/**
 * InspectPoint's `System/Asset Type` values that are INTERNAL PLUMBING, not
 * something to say to a customer. Measured across the live tenant's 436 open
 * deficiencies: "Inspection custom inspection" (183), "Asset" (99),
 * "Equipment" (75) and "Inspection external form" (66) account for 97% of rows
 * and mean nothing to the person on the phone. Only "Fire Extinguisher" (8) and
 * "Fire Exit Sign" (5) are real equipment families.
 *
 * So the grouping is opt-IN on recognisable names rather than opt-out on a
 * denylist that would need updating every time InspectPoint adds an internal
 * type — an unknown value is far more likely to be plumbing than a real family.
 */
const SPEAKABLE_ASSET_TYPES = new Set([
  "fire extinguisher", "fire exit sign", "fire door", "fire damper", "fire hose",
  "alarm system", "sprinkler", "back flow", "backflow", "clean agent system",
  "control panel", "valve", "dry valve", "hose valve", "cylinder",
  "special hazard", "monitoring system",
]);

/**
 * A spoken headline for the open deficiencies: "13 open items from the last
 * inspection, including 8 on fire extinguishers".
 *
 * Severity is NOT used — InspectPoint's deficiency_status is null on 436 of 439
 * rows in the live tenant. Asset family is used only where it is a real
 * equipment name (see above); otherwise the count alone is the honest headline,
 * because "8 on inspection custom inspection" is worse than saying nothing.
 */
function summariseDeficiencies(repairs) {
  if (!repairs.length) return null;
  const noun = repairs.length === 1 ? "open item" : "open items";
  const headline = `${repairs.length} ${noun} from the last inspection`;

  const byType = new Map();
  for (const r of repairs) {
    const raw = r.asset?.asset_type || r.asset_type || null;
    if (!raw) continue;
    const key = String(raw).trim().toLowerCase();
    if (!SPEAKABLE_ASSET_TYPES.has(key)) continue;
    byType.set(key, (byType.get(key) || 0) + 1);
  }
  if (!byType.size) return headline;

  const parts = [...byType.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${n} on ${type}${n === 1 ? "" : "s"}`);
  return `${headline}, including ${spokenList(parts)}`;
}

function dedupe(values) {
  return [...new Set(values.filter((v) => v != null && String(v).trim() !== ""))];
}

/**
 * ServiceTrade service descriptions are free text and routinely carry
 * dispatcher notes rather than a service name — job 33276 has
 * "**MOVED TO AUG 2025 TO MAKE ON SAME SCHEDULE AS ALARM**\nAnnual Fire
 * Sprinkler Inspection (1-wet)(1-dry)". Read aloud verbatim that is nonsense
 * to a customer, so strip **…** note blocks, collapse the embedded newlines
 * and trailing spaces, and keep what's left.
 */
function cleanServiceDescription(desc) {
  if (!desc) return null;
  const cleaned = String(desc)
    .replace(/\*\*[^*]*\*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

/** "Backflow / Fire Protection" -> "Backflow" (drop the trade suffix). */
function headSegment(line) {
  return String(line).split("/")[0].trim();
}

/** ["a","b","c"] -> "a, b and c" — spoken, not a comma-jammed list. */
function spokenList(items) {
  const v = dedupe(items);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  return `${v.slice(0, -1).join(", ")} and ${v[v.length - 1]}`;
}

function isUpcoming(appt, now) {
  if (!appt || !UPCOMING_STATUSES.includes(appt.status)) return false;
  if (!appt.scheduled_start) return false;
  return new Date(appt.scheduled_start).getTime() > now.getTime();
}

/** Technician names per appointment, from the FULL techs[] list the sync captures. */
async function fetchTechniciansByAppointment(appointmentIds) {
  const grouped = new Map();
  if (!appointmentIds.length) return grouped;
  // `appointment_technicians` has no company_id — tenant scoping comes from the
  // appointment ids, which the caller already scoped via getJobById.
  const { rows } = await db.query(
    // Ordered so the crew reads the same way on every turn and every call.
    // Without it Postgres is free to return a different order each time, which
    // on a re-rendered prompt looks like the crew changed.
    `SELECT at.appointment_id,
            t.first_name || ' ' || t.last_name AS name,
            t.phone, t.email
       FROM appointment_technicians at
       JOIN technicians t ON t.id = at.technician_id
      WHERE at.appointment_id = ANY($1::int[])
      ORDER BY at.appointment_id, t.first_name, t.last_name, t.id`,
    [appointmentIds]
  );
  for (const r of rows) {
    if (!grouped.has(r.appointment_id)) grouped.set(r.appointment_id, []);
    const list = grouped.get(r.appointment_id);
    const name = (r.name || "").trim() || null;
    // The same person can be attached twice (two service lines on one visit);
    // the customer should hear them once.
    if (name && list.some((t) => t.name === name)) continue;
    list.push({ name, phone: r.phone ?? null, email: r.email ?? null });
  }
  return grouped;
}

async function fetchJobComments(companyId, jobId) {
  const [comments, notes] = await Promise.all([
    db.query(
      `SELECT content FROM scheduling_comments
        WHERE company_id = $1 AND job_id = $2 AND content IS NOT NULL AND content <> ''
        ORDER BY created_at DESC LIMIT 10`,
      [companyId, jobId]
    ),
    db.query(
      `SELECT type, text FROM job_notes
        WHERE company_id = $1 AND job_id = $2 AND text IS NOT NULL AND text <> ''
        ORDER BY created_at DESC LIMIT 10`,
      [companyId, jobId]
    ),
  ]);
  return {
    comments: comments.rows.map((r) => r.content),
    notes: notes.rows.map((r) => ({ type: r.type ?? null, text: r.text })),
  };
}

/**
 * @param {number|string} jobId — `scheduled_calls.job_id` is TEXT and also
 *   carries synthetic ids ('quotation:N', 'service_opportunity:N-N'), so a
 *   non-numeric value is rejected rather than coerced.
 * @param {object} [opts]
 * @param {string}  [opts.tz]     resolved from the company when omitted
 * @param {Date}    [opts.now]
 * @param {object}  [opts.job]    an already-fetched getJobById result, to avoid a second read
 */
async function buildJobConfirmationContext(companyId, jobId, opts = {}) {
  const numericJobId = Number(jobId);
  if (!Number.isInteger(numericJobId) || numericJobId <= 0) {
    return { ok: false, status: 400, code: "not_a_job", error: `Not a numeric job id: ${jobId}` };
  }

  const now = opts.now instanceof Date ? opts.now : new Date();
  const tz = opts.tz || (await getCompanyTimezone(companyId));
  const job = opts.job || (await jobsDb.getJobById(numericJobId, companyId));
  if (!job) return { ok: false, status: 404, code: "job_not_found", error: "Job not found" };

  const all = Array.isArray(job.appointments) ? job.appointments : [];
  // getJobById returns newest-first; the lead appointment is the EARLIEST
  // future one, so re-sort rather than trusting that order.
  const upcomingRaw = all
    .filter((a) => isUpcoming(a, now))
    .sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start));
  const historyRaw = all.filter((a) => !isUpcoming(a, now));

  const [techsByAppt, { comments, notes }] = await Promise.all([
    fetchTechniciansByAppointment(all.map((a) => a.id)),
    fetchJobComments(companyId, numericJobId),
  ]);

  // Only used to name the work when an appointment has no appointment_services.
  let jobServiceLines = [];
  if (upcomingRaw.some((a) => !a.service_line)) {
    jobServiceLines = await jobsDb.fetchJobServiceLines(companyId, numericJobId).catch(() => []);
  }


  // Built field-by-field, never spread from the DB row: raw ISO timestamps must
  // not reach an agent (it would read them aloud verbatim).
  const shape = (appt, { isNext = false } = {}) => {
    const allRows = Array.isArray(appt.services) ? appt.services : [];
    // PARTITION FIRST, and never let a repair reach the `service_*` fields.
    //
    // Open deficiencies are projected onto the visit as appointment_services
    // rows (kind='deficiency_repair') so they travel this same path — but
    // `service_lines`, `service_names`, `service_details` AND `service_summary`
    // below all describe what the visit IS, and `service_summary` feeds the
    // agent's OPENING LINE. Leaving repairs in that set makes the agent open
    // with "Backflow, Alarm Systems, and valve tamper switch repair",
    // announcing unscheduled work as booked. Rows written before migration 110
    // have kind='service' by default, so this partition is a no-op for them.
    const svc = allRows.filter((s) => (s.kind || "service") === "service");
    const repairs = allRows.filter((s) => s.kind === "deficiency_repair");
    // Every service on the visit, not just the first. A single appointment
    // routinely bundles several (job 33276: backflow + fire alarm +
    // extinguisher + sprinkler), and naming only services[0] told the customer
    // about one of four — and left the agent unable to pick the combined
    // onsite-expectation entry, which is keyed on the full set.
    // Prefer the explicit name field, falling back to the combined
    // `service_line` — tolerant of both row shapes rather than assuming one.
    const svcLine = (s) => s.service_line_name || s.service_line || null;
    const lines = dedupe(svc.map(svcLine));
    const detail = dedupe(svc.map((s) => cleanServiceDescription(s.description)));

    // Line name AND description, kept together. `lines` and `detail` above are
    // deduped independently, which loses the pairing: three services collapse
    // into two lists the agent can't reassociate. The description is the rich
    // part ("Annual Backflow Inspection (1-FL/2-Dom/…/Pool Mechanical Room)")
    // but is meaningless without the category it belongs to, so this is the
    // form the prompt actually consumes. Deduped on the PAIR.
    const seenPair = new Set();
    const serviceDetails = [];
    for (const s of svc) {
      const line = svcLine(s);
      const description = cleanServiceDescription(s.description);
      if (!line && !description) continue;
      const key = `${line} ${description}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      serviceDetails.push({ service_line: line, description });
    }

    // The whole crew, not just appointments.technician_id. 240 of company 9's
    // 459 appointments have more than one technician assigned (up to four), so
    // naming only the single joined technician understated who is turning up.
    // Falls back to that single technician when the junction is empty.
    const crew = techsByAppt.get(appt.id) || [];
    const crewNames = dedupe(crew.map((t) => t.name));
    const fallbackName = appt.technician_name || null;
    const technicianNames = crewNames.length ? crewNames : dedupe([fallbackName]);
    return ({
    appointment_id: appt.id,
    status: appt.status,
    scheduled_start: appt.scheduled_start, // internal: sorting/derivation only
    scheduled_start_spoken: formatSpokenDateTime(appt.scheduled_start, tz),
    scheduled_end_spoken: formatSpokenDateTime(appt.scheduled_end, tz),
    // "between 7:30 AM and 8:30 AM" — the honest arrival expectation, since a
    // crew does not land on the minute. Precomputed because a model doing this
    // arithmetic gets hour and noon boundaries wrong. null on a DST fall-back
    // night, where both bounds are the same wall-clock time.
    arrival_window_spoken: formatArrivalWindow(appt.scheduled_start, tz, ARRIVAL_WINDOW_MINUTES),
    customer_confirmed: appt.customer_confirmed === true,
    technician_confirmed: appt.technician_confirmed === true,
    // Kept for back-compat; explicitly "the lead", not "the technician".
    technician: appt.technician_name || null,
    // Full crew with contact details, and the two derived forms the prompts
    // and dynamic variables consume.
    technicians: crew.length ? crew : (fallbackName ? [{ name: fallbackName, phone: appt.technician_phone ?? null, email: null }] : []),
    technician_names: technicianNames,
    technician_summary: spokenList(technicianNames),
    // Kept as-is: existing callers (and the back-compat single-value dynamic
    // variable) still read it. It is now explicitly "the first of", not "the".
    service_line: appt.service_line || jobServiceLines[0] || null,
    // All of them. `service_lines` is the clean category list; `service_names`
    // is the specific per-service wording ("Annual Fire Alarm Inspection"),
    // which is what matches the onsite-expectation entries.
    service_lines: lines.length ? lines : (jobServiceLines[0] ? [jobServiceLines[0]] : []),
    service_names: detail,
    // ── Open issues at this site (CMAP-228) ───────────────────────────────
    // Named "issue", not "deficiency": deficiency is InspectPoint's word, and
    // ServiceTrade has 105 of its own. One prompt serves every CRM only if the
    // variable it reads is the platform's vocabulary rather than one vendor's.
    // Deliberately SIBLINGS of the service_* fields, never merged into them:
    // these are repairs being OFFERED, not work already booked.
    //
    // No severity field. InspectPoint's deficiency_status is null on 436 of
    // 439 rows in the only live tenant, so a "1 critical, 2 non-critical"
    // variable would be blank almost always — and a variable that is usually
    // blank teaches the model to ignore it.
    open_issue_count: repairs.length,
    // Grouped by equipment family, which IS reliably present, so the agent can
    // lead with "three items on the fire suppression system" before any detail.
    open_issue_summary: summariseDeficiencies(repairs),
    // The specifics, for when the customer asks "like what?". Capped: one site
    // in the live tenant has 29 open items and reading them all would be
    // unusable. Oldest first — with severity unavailable, age is the only
    // honest ordering.
    open_issue_details: repairs
      .slice(0, MAX_SPOKEN_DEFICIENCIES)
      .map((r) => cleanServiceDescription(r.description))
      .filter(Boolean),
    // [{service_line, description}] — the pairing, for anything that needs to
    // state what the visit covers rather than just list categories.
    service_details: serviceDetails.length
      ? serviceDetails
      : (jobServiceLines[0] ? [{ service_line: jobServiceLines[0], description: null }] : []),
    // Short spoken form for the opening line: "Backflow, Alarm Systems,
    // Portable Extinguishers and Sprinkler". Built from the category list
    // rather than the descriptions, which carry trade suffixes, embedded
    // newlines and scheduling notes that read badly aloud.
    service_summary: spokenList(lines.map(headSegment)) || jobServiceLines[0] || null,
    services: appt.services || [],
    is_next: isNext,
  });
  };

  const upcoming = upcomingRaw.map((a, i) => shape(a, { isNext: i === 0 }));
  const history = historyRaw.map((a) => shape(a));
  const unconfirmed = upcoming.filter((a) => !a.customer_confirmed).length;
  const c = job.customer || {};
  const t = job.technician || {};

  return {
    ok: true,
    tz,
    job: {
      id: job.id,
      job_number: job.job_number ?? null,
      title: job.title ?? null,
      description: job.description ?? null,
      job_type: job.job_type ?? null,
      status: job.status,
      scheduled_date: formatSpokenDateOnly(job.scheduled_date),
      customer: {
        name: c.full_name ?? null,
        phone: c.phone ?? null,
        email: c.email ?? null,
        address: [c.address_line1, c.city, c.state, c.zipcode].filter(Boolean).join(", ") || null,
      },
      technician: t.name ? { name: t.name, phone: t.phone ?? null } : null,
      location_name: job.location_name ?? null,
      comments,
      notes,
      contacts: opts.includeContacts ? (job.contacts || []) : undefined,
    },
    appointments: { upcoming, next: upcoming[0] || null, history },
    counts: {
      upcoming: upcoming.length,
      confirmed: upcoming.length - unconfirmed,
      unconfirmed,
      all_confirmed: upcoming.length > 0 && unconfirmed === 0,
    },
  };
}

function truncate(str, max) {
  if (!str) return str;
  return str.length <= max ? str : `${str.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Flat, string-only variables for Retell's `retell_llm_dynamic_variables`.
 *
 * JOB-LEVEL ONLY, deliberately. Appointment facts are NOT injected here — the
 * agent must fetch them with the get_appointments tool. Retell binds dynamic
 * variables once (at createCall / chat.create), so anything appointment-shaped
 * put here would be a snapshot that goes stale as appointments are added, moved,
 * cancelled or confirmed mid-conversation, and there'd be two sources of the
 * same fact that can disagree.
 *
 * Never emits an empty string for anything a sentence interpolates — a blank
 * renders as a dangling sentence the agent reads out.
 */
function toDynamicVariables(ctx) {
  if (!ctx?.ok) return {};
  const { job } = ctx;
  // Deficiencies are the one appointment-shaped thing that IS safe to bind
  // here, and the exception is worth stating: they belong to the SITE, not the
  // visit, and a repair opened months ago does not resolve itself mid-call. The
  // staleness argument above is about confirmation state, which changes while
  // the agent is talking; this does not.
  const next = ctx.appointments?.next || null;
  const defCount = next?.open_issue_count || 0;
  return {
    job_number: job.job_number || String(job.id),
    job_comments: job.comments.length
      ? truncate(job.comments.slice(0, MAX_COMMENTS).join(" | "), MAX_COMMENT_CHARS)
      : "none",
    // The opening line greets the site: "Hi {{location_name}}, this is …".
    // Falls back to the customer rather than going blank — most jobs have no
    // location row, and "Hi , this is Clara" is a worse first impression than
    // a slightly generic one. Only emitted when SOMETHING is known, so the
    // registered "" default still applies when neither is.
    ...((job.location_name || job.customer?.name)
      ? { location_name: job.location_name || job.customer.name }
      : {}),
    // ── Open deficiencies (CMAP-228) ──────────────────────────────────────
    // Always emitted, including the zero case, so the prompt can branch on
    // "0" rather than on an undefined variable — a missing variable renders
    // as the literal "{{open_issue_count}}" in some Retell templates.
    open_issue_count: String(defCount),
    open_issue_summary: next?.open_issue_summary || "none",
    // Pipe-joined rather than a JSON array: dynamic variables are string-only,
    // and a stringified array reads aloud as punctuation.
    open_issue_details: defCount && next?.open_issue_details?.length
      ? truncate(next.open_issue_details.join(" | "), MAX_COMMENT_CHARS)
      : "none",
  };
}

/**
 * Everything the agent needs about a job's appointments — the payload of the
 * get_appointments tool, and the ONLY route by which appointment data reaches
 * the agent.
 *
 * `upcoming[0]` is always the lead (earliest future) appointment and is also
 * exposed as `next` for convenience. `past` is capped — enough for "were you out
 * here in June?" without paying for full history.
 */
function toAppointmentsPayload(ctx) {
  if (!ctx?.ok) return null;
  const { job, appointments, counts } = ctx;
  // Raw ISO timestamps must never reach the agent — it reads them aloud
  // verbatim. Only the *_spoken variants survive this.
  const strip = ({ scheduled_start, ...rest }) => rest;

  return {
    job_id: job.id,
    upcoming_count: counts.upcoming,
    unconfirmed_count: counts.unconfirmed,
    all_upcoming_confirmed: counts.all_confirmed,
    next: appointments.next ? strip(appointments.next) : null,
    upcoming: appointments.upcoming.map(strip),
    past: appointments.history.slice(0, MAX_PAST_APPOINTMENTS).map(strip),
  };
}

module.exports = {
  UPCOMING_STATUSES,
  buildJobConfirmationContext,
  toDynamicVariables,
  toAppointmentsPayload,
};
