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
const { getCompanyTimezone, formatSpokenDateTime, formatSpokenDateOnly } = require("../utils/timezone");
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

/** Distinct, non-empty, order-preserving. */
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
    const svc = Array.isArray(appt.services) ? appt.services : [];
    // Every service on the visit, not just the first. A single appointment
    // routinely bundles several (job 33276: backflow + fire alarm +
    // extinguisher + sprinkler), and naming only services[0] told the customer
    // about one of four — and left the agent unable to pick the combined
    // onsite-expectation entry, which is keyed on the full set.
    const lines = dedupe(svc.map((s) => s.service_line));
    const detail = dedupe(svc.map((s) => cleanServiceDescription(s.description)));

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
