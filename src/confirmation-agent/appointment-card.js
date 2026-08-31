/**
 * The appointment "card" contract — the one shape the widget's cards are
 * built from, everywhere: GET /chat-links/:token's initial load, and every
 * card-action route's response after a write.
 *
 * Deliberately NOT the raw `ctx.appointments.upcoming[i]` shape
 * (job-confirmation-context.js) — that carries internal detail (raw DB
 * `status` strings, an `is_next` flag, a `services` grab-bag array) a
 * frontend has no business depending on. This is the stable, versioned
 * boundary; job-confirmation-context.js's shape can keep evolving for the
 * LLM prompt's own needs without silently changing what the widget renders.
 *
 * `job_number`/`location_name` are merged in from `ctx.job` — they live one
 * level up in job-confirmation-context.js's own shape (per-job, not
 * per-appointment), but a card needs them per-appointment since a card is
 * everything a customer needs to act on ONE visit without more context.
 *
 * `actions_available` is computed HERE, server-side — same philosophy as
 * registry.js's PHASE_TOOLS ("constrain what's possible structurally, not by
 * convention"): the frontend never re-derives whether a button should show.
 */

/** appt.status (job-confirmation-context.js's raw DB value) → the card's clean enum. */
function cardStatus(appt) {
  if (appt.status === "cancelled") return "cancelled";
  if (appt.customer_confirmed === true) return "confirmed";
  return "not_confirmed";
}

function actionsFor(status) {
  if (status === "confirmed") return ["reschedule", "cancel"];
  if (status === "not_confirmed") return ["confirm", "reschedule", "cancel"];
  return []; // cancelled — nothing left to do on this card
}

const { resolveOnsiteInstructions } = require("../services/onsite-instructions-resolver");

/**
 * @param {object} appt   one entry from ctx.appointments.upcoming (or .history)
 * @param {object} job    ctx.job — for job_number/location_name only
 * @param {{sent:boolean, url:string|null}|null} [serviceLink] — the job's
 *   service-link status (service_link_messages, keyed by this conversation's
 *   token — NOT per-appointment; a job has exactly one, echoed identically
 *   onto every card for it, same as job_number/location_name above).
 * @param {object[]} [onsiteInstructionsAll] — the company's FULL
 *   onsite_instructions list (db/onsite-instructions.js, unfiltered) —
 *   matched here against this one appointment's own service_line. Passed
 *   straight through by every card-returning route so a card click can
 *   deliver this content — narration structurally can't reach one (see
 *   graph/build.js's afterTools).
 */
function buildAppointmentCard(appt, job, serviceLink = null, onsiteInstructionsAll = []) {
  const status = cardStatus(appt);
  const onsiteInstructions = resolveOnsiteInstructions(onsiteInstructionsAll, appt.service_line ?? null);
  return {
    appointment_id: appt.appointment_id,
    job_number: job?.job_number ?? null,
    job_title: job?.title ?? null,
    location_name: job?.location_name ?? null,
    scheduled_start: appt.scheduled_start ?? null,
    scheduled_start_label: appt.scheduled_start_spoken ?? null,
    arrival_window_label: appt.arrival_window_spoken ?? null,
    service_line: appt.service_line ?? null,
    service_requests: (appt.service_details || []).map((d) => ({ line: d.service_line ?? null, description: d.description ?? null })),
    technicians: (appt.technicians || []).map((t) => ({ name: t.name ?? null, phone: t.phone ?? null, email: t.email ?? null })),
    status,
    actions_available: actionsFor(status),
    service_link: { sent: serviceLink?.sent === true, url: serviceLink?.url ?? null },
    onsite_instructions: onsiteInstructions.map((i) => ({ text: i.instruction, requires_response: i.requires_response === true })),
  };
}

/** Every upcoming appointment on a job, as cards — the shape every action route returns. */
function buildAppointmentCards(ctx, serviceLink = null, onsiteInstructionsAll = []) {
  return (ctx?.appointments?.upcoming || []).map((appt) => buildAppointmentCard(appt, ctx.job, serviceLink, onsiteInstructionsAll));
}

module.exports = { buildAppointmentCard, buildAppointmentCards };
