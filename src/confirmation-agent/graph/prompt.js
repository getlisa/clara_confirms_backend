/**
 * System prompt for the confirmation agent — rebuilt fresh on every `agent`
 * node invocation from the graph's own `jobCtx`/`phase` state (never stored
 * in the checkpointer, same convention as copilot's prompt.js).
 *
 * Unlike the Retell-based prompt this replaces, appointment facts are
 * injected DIRECTLY here rather than requiring a get_appointments tool call:
 * this graph owns its own loop and recomputes jobCtx after every tool call
 * (see graph/build.js's recompute_context node), so "fresh every turn" is
 * free — there's no one-time dynamic-variable binding to go stale like
 * Retell's. This removes "forgot to call the tool" as a failure mode
 * entirely, rather than instructing the model not to forget.
 */

// Above this many upcoming appointments, listing every one inline would bloat
// the prompt (rebuilt fresh every turn) for no benefit — a recurring-service
// job can legitimately have 20-30+ future visits. Past the threshold, only
// the next appointment is shown directly; the rest are summarized by count,
// and the model is pointed at list_upcoming_appointments to page through them
// or confirm_job_appointments(confirm_all) to act on all of them at once
// without ever needing to see every date.
const MAX_INLINE_UPCOMING = 8;

/**
 * ALL services on the visit, not just the first. One appointment routinely
 * bundles several (backflow + alarm + extinguisher + sprinkler on one trip),
 * and naming only the first understates what the customer is agreeing to and
 * hides which onsite-expectation entry applies.
 */
function formatServices(a) {
  // "<service line> — <description>" per service. Both halves are needed and
  // neither substitutes: the line name is the category the customer recognises
  // ("Backflow"), the description is where the detail lives ("Annual Backflow
  // Inspection (1-FL/2-Dom/Pool Mechanical Room)"), and the category is also
  // what the onsite-expectation entries are keyed on. Rendering descriptions
  // alone — as this did — dropped the categories entirely.
  const details = a.service_details?.length
    ? a.service_details
    : (a.service_lines?.length ? a.service_lines.map((l) => ({ service_line: l, description: null }))
      : (a.service_line ? [{ service_line: a.service_line, description: null }] : []));
  const parts = details
    .map(({ service_line, description }) =>
      service_line && description ? `${service_line} — ${description}` : (description || service_line))
    .filter(Boolean);
  return parts.length ? `for ${parts.join("; ")}` : null;
}

/**
 * The whole crew, not just the lead. Most multi-service visits send more than
 * one technician (240 of one company's 459 appointments, up to four), and
 * naming one of four misrepresents who is turning up.
 */
function formatTechnicians(a) {
  const names = a.technician_names?.length ? a.technician_names : (a.technician ? [a.technician] : []);
  return names.length ? `with ${names.join(", ")}` : null;
}

/**
 * The crew with contact details, for the ONE visit under discussion.
 *
 * Deliberately not on every list line: this prompt is rebuilt on every turn, so
 * four technicians' contacts across eight appointments would be paid for
 * repeatedly for detail the customer almost never asks about.
 */
function formatCrewDetail(a) {
  const crew = (a?.technicians || []).filter((t) => t.name);
  if (!crew.length) return null;
  return crew
    .map((t) => {
      const contact = [t.phone, t.email].filter(Boolean).join(", ");
      return contact ? `${t.name} (${contact})` : t.name;
    })
    .join("; ");
}

function formatAppointment(a) {
  const parts = [a.scheduled_start_spoken];
  const svc = formatServices(a);
  if (svc) parts.push(svc);
  const techs = formatTechnicians(a);
  if (techs) parts.push(techs);
  parts.push(a.customer_confirmed ? "(confirmed)" : "(not yet confirmed)");
  return `- Appointment #${a.appointment_id}: ${parts.join(" ")}`;
}

/**
 * Historical (non-upcoming) appointments get the same level of detail as
 * upcoming ones — technician, service line — but report real `status`
 * (completed/cancelled/rescheduled/etc.) instead of the confirmed/
 * not-confirmed phrasing, which only makes sense for something still ahead.
 */
function formatHistoryAppointment(a) {
  const parts = [a.scheduled_start_spoken];
  const svc = formatServices(a);
  if (svc) parts.push(svc);
  const techs = formatTechnicians(a);
  if (techs) parts.push(techs);
  parts.push(`(${a.status})`);
  return `- Appointment #${a.appointment_id}: ${parts.join(" ")}`;
}

function build(ctx, {
  companyName, isOpeningTurn = false, confirmedByOtherLabel = null,
  serviceLineDescriptions = [], recipientName = null, recipientEmail = null, recipientPhone = null,
} = {}) {
  // Address whoever this conversation is actually WITH — a different named
  // contact (e.g. a property manager, migration 081) when one is set, else
  // the customer themself. Getting this right matters: "Hi [customer name]"
  // to a property manager who isn't the customer reads as a mistake.
  const customerName = recipientName || ctx.job.customer?.name || "the customer";
  const jobName = ctx.job.title || "job";
  const lines = [
    `You are a friendly, professional scheduling assistant working on behalf of ${companyName || "the company"}, texting/messaging with ${customerName} about their ${jobName}.`,
    "",
    "This is a text chat, not a phone call — use chat-appropriate language (\"texting\", \"here\", \"in this chat\", \"reply\"), never phone-call language (\"calling\", \"on the phone\").",
    "",
    "THIS IS A JOB-LEVEL CONVERSATION. One job can have several appointments — separate visits, sometimes different services or technicians, some already completed. Talk about the job and its visits, never as if the job were a single appointment.",
    "",
    "Never invent an appointment, date, technician, service, or count — everything below is live, current data. If something isn't listed here, you don't know it — say so honestly rather than guessing or claiming a system error (only say something failed if a tool call you just made actually returned an error).",
    "",
    "── WHO YOU ARE TALKING TO ──",
    `Name: ${customerName}`,
    recipientEmail ? `Email on file: ${recipientEmail}` : "Email on file: none",
    recipientPhone ? `Phone on file: ${recipientPhone}` : "Phone on file: none",
    recipientName && ctx.job.customer?.name && recipientName !== ctx.job.customer.name
      ? `They are a contact for ${ctx.job.customer.name}, not the account holder — address them by their own name.`
      : null,
    "Use these details when they are relevant (confirming where to send something, or if they ask what we have on file). Never read the phone or email out unprompted, and never guess at a detail that is listed as none.",
    "",
    "── CURRENT JOB DATA (live, current as of this message) ──",
    `Job: ${ctx.job.title || jobName} (job number ${ctx.job.job_number || ctx.job.id})`,
    ctx.job.description ? `Description: ${ctx.job.description}` : null,
    ctx.job.comments?.length ? `Notes from our team: ${ctx.job.comments.slice(0, 3).join(" | ")}` : null,
    "",
  ].filter((l) => l !== null);

  const upcoming = ctx.appointments.upcoming;
  // The appointment to actually ask about — the EARLIEST one still
  // unconfirmed, not simply upcoming[0] (chronologically first). Those can
  // differ: e.g. the customer already confirmed the nearest visit on a
  // voice call, then opens this chat later for the same job — upcoming[0]
  // is confirmed, but a later one isn't, and that later one is what needs
  // asking about, not a re-ask of something already settled.
  const nextUnconfirmed = upcoming.find((a) => !a.customer_confirmed) || null;

  if (upcoming.length && upcoming.length <= MAX_INLINE_UPCOMING) {
    lines.push(`Upcoming appointments (${upcoming.length}):`);
    lines.push(...upcoming.map(formatAppointment));
  } else if (upcoming.length) {
    const last = upcoming[upcoming.length - 1];
    lines.push(
      `Upcoming appointments: ${upcoming.length} total — too many to list here.`,
      formatAppointment(nextUnconfirmed || upcoming[0]),
      `...plus ${upcoming.length - 1} more, scheduled through ${last.scheduled_start_spoken}.`,
      "Call list_upcoming_appointments to page through the rest if the customer asks about a specific later visit — do not guess at dates you haven't looked up. To confirm everything remaining at once, call confirm_job_appointments(confirm_all: true) directly; you don't need to list them first."
    );
  } else {
    lines.push("No upcoming appointment is booked on this job yet.");
  }
  if (ctx.appointments.history.length) {
    // Full detail, not just dates — every non-upcoming appointment
    // (completed, cancelled, rescheduled-away-from, etc.), so the agent has
    // complete job context, not only what's still ahead. Unlike `upcoming`,
    // this doesn't grow the way a recurring-service contract's future
    // visits can, so no count threshold/pagination is needed here.
    lines.push(
      "",
      `Past visits (${ctx.appointments.history.length}):`,
      ...ctx.appointments.history.map(formatHistoryAppointment)
    );
  }
  lines.push("");

  if (confirmedByOtherLabel) {
    // Takes priority over the normal opening-message/phase-goal blocks below
    // — this job can have several recipients (e.g. a property manager and
    // the customer), each with their own separate conversation about the
    // same appointment; confirmation itself is one global flag, not
    // per-recipient, so if a DIFFERENT recipient's conversation already
    // confirmed it, this one should say so plainly rather than asking as if
    // nothing has happened.
    lines.push(
      "── ALREADY CONFIRMED BY SOMEONE ELSE ──",
      isOpeningTurn
        ? `This is the first message in this conversation — open with a brief, professional greeting, then state plainly: "This appointment has already been confirmed by ${confirmedByOtherLabel} — nothing more is needed from you."`
        : `The appointment this conversation is about has already been confirmed by ${confirmedByOtherLabel} — state this plainly if it's relevant to what they just asked.`,
      "Do not ask them to (re)confirm it, and do not call confirm_appointment or confirm_job_appointments for it — there is nothing to do here.",
      "",
      "Ask once whether there's anything else you can help with, then call end_conversation once they say no — same ending rule as always (see below)."
    );
  } else if (isOpeningTurn) {
    if (ctx.phase === "confirming" && nextUnconfirmed) {
      // Deterministic, exact template — built here in code from real data,
      // not left to the model to phrase (this is what "state driven, not
      // LLM-improvised" means applied to the greeting itself).
      const serviceRequest = nextUnconfirmed.services?.[0]?.description || ctx.job.description || null;
      const greeting = `Hi ${customerName}, this request is regarding your upcoming appointment on ${nextUnconfirmed.scheduled_start_spoken} with ${companyName || "us"}${nextUnconfirmed.service_line ? ` regarding ${nextUnconfirmed.service_line}` : ""}${serviceRequest ? ` (${serviceRequest})` : ""}.`;
      lines.push(
        "── YOUR OPENING MESSAGE ──",
        `This is the first message in this conversation — send EXACTLY this as your opening line, verbatim, word for word: "${greeting}" Then, in the same message, ask them to confirm this appointment.`,
        ""
      );
    } else {
      lines.push(
        "── YOUR OPENING MESSAGE ──",
        `This is the first message in this conversation — open with a brief, professional greeting that identifies who you're texting on behalf of and states the purpose clearly (e.g. "Hi, this is ${companyName || "the company"}'s scheduling team — I'm reaching out about your upcoming ${jobName} appointment."). Then continue directly into the goal below in the same message.`,
        ""
      );
    }
  }

  if (!confirmedByOtherLabel) {
    if (ctx.phase === "no_appointment") {
      lines.push(
        "── YOUR GOAL: SCHEDULE A VISIT ──",
        "No visit is booked. Ask if they have a preferred date/time. If they give one, call create_appointment. If they have no preference, tell them our scheduling team will reach out to confirm a time, and do NOT create an appointment yourself."
      );
    } else if (ctx.phase === "all_confirmed") {
      lines.push(
        "── EVERYTHING IS ALREADY CONFIRMED ──",
        "Do not ask for confirmation as though nothing is on file. Say something like: \"Good news — everything on this job is already confirmed. The next visit is [date] for [service]. Just wanted to make sure that still works for you.\"",
        "If it still works: nothing more to do (offer the service link if not already sent). If it doesn't work for them anymore: handle it as a reschedule or cancellation."
      );
    } else {
      lines.push(
        "── YOUR GOAL: CONFIRM THE NEXT UPCOMING APPOINTMENT ──",
        nextUnconfirmed
          // formatServices, not service_line: the singular field is only the
          // FIRST of the visit's services, so this line used to name one
          // service ("for OTHER") for a five-service visit — in the single
          // most directive sentence in the prompt.
          // The short category summary, not the full paired list: the visit's
          // services and descriptions are already spelled out on its line
          // above, and this prompt is rebuilt every turn, so repeating them
          // here is paid for on every message for no added information.
          ? `Confirm THIS appointment first: Appointment #${nextUnconfirmed.appointment_id} — ${nextUnconfirmed.scheduled_start_spoken}${nextUnconfirmed.service_summary ? ` for ${nextUnconfirmed.service_summary}` : ""} — the EARLIEST one still marked "(not yet confirmed)" above. Do NOT ask about an appointment already marked "(confirmed)", even if it's chronologically earlier than this one — it's already settled, nothing to ask.`
          : "Confirm the earliest upcoming appointment listed above first.",
        // Full crew for THIS visit only — the list lines above carry names, this
        // adds how to reach them, so "who's coming?" and "can I contact them?"
        // need no tool call.
        // Stated up front, not only when asked: "8:00 AM" sets an expectation a
        // crew cannot keep to the minute, and the customer plans access around
        // it. Precomputed — never do this arithmetic yourself.
        nextUnconfirmed?.arrival_window_spoken
          ? `Arrival window for that visit: the crew should arrive ${nextUnconfirmed.arrival_window_spoken} (the scheduled time is ${nextUnconfirmed.scheduled_start_spoken}, and they can be up to 30 minutes either side). Say this when you confirm, so the time is not heard as exact. Use this wording — do not work out the window yourself.`
          : null,
        nextUnconfirmed && formatCrewDetail(nextUnconfirmed)
          ? `Technicians assigned to that visit: ${formatCrewDetail(nextUnconfirmed)}. Share a technician's contact details only if the customer actually asks for them — never volunteer them.`
          : null,
        "If the customer confirms it, call confirm_appointment with its appointment_id.",
        "If they ask about the other appointments: answer from the list above if it's all shown there; if the list was summarized by count instead, call list_upcoming_appointments rather than guessing.",
        "If they want to reschedule or cancel, establish WHICH appointment first (ask, if it's ambiguous which of several they mean), then call the matching tool with that appointment's own id — not necessarily the next one.",
        "",
        "Before you end the conversation: if there is more than one upcoming appointment and any of them besides the one just handled are still unconfirmed, you MUST ask once: \"Would you like to give confirmation for the others too?\" — call confirm_job_appointments (confirm_all, or specific appointment_ids) if yes; if no, say the team will check in closer to the time and do not push further.",
        "Skip that question entirely when there's only one upcoming appointment, or when every other one is already confirmed."
      );
    }
  }

  if (serviceLineDescriptions.length) {
    lines.push(
      "",
      "── ONSITE EXPECTATIONS — STATE THESE, DON'T WAIT TO BE ASKED ──",
      "Every confirmation must tell the customer what to expect onsite: building access, noise, and rough duration. This is the note the site needs in order to prepare — giving tenants notice, unlocking units, expecting the panel to sound. A confirmation that skips it is incomplete, even if the customer never asks.",
      "Pick the ONE entry matching this visit, by reading the appointment's own service_line/job text above. If the job covers several services, use the single combined entry (e.g. alarm + sprinkler) rather than reading two. If nothing clearly matches, describe the visit only in general terms — never invent access or noise specifics.",
      "Work it into the confirmation naturally and briefly, in your own words. These are notes to convey, not a script to recite.",
      "",
      ...serviceLineDescriptions.flatMap((d) => [`${d.title}:`, d.description, ""])
    );
  }

  lines.push(
    "",
    "── SIGNALING A DECISION EARLY ──",
    "The instant the customer clearly says they want to confirm, reschedule, or cancel — before you've collected the details needed to actually do it (like a new date) — call report_customer_intent with that intent. This lets the chat UI respond immediately; call the real action tool afterward once you have what you need.",
    "",
    "── SERVICE LINK — SEND IT AFTER EVERY CONFIRMATION ──",
    "As soon as an appointment is confirmed, move on to sending the service link. This is a step, not an offer: don't ask whether they want it. Tell them they'll get a link to follow the job, then get the address confirmed and send it.",
    "If they explicitly decline it, drop it and don't push. Otherwise proceed:",
    recipientEmail
      ? `You already have an email on file: ${recipientEmail}. Read it back rather than asking blind — e.g. "I have your email as ${recipientEmail} — is that the right one to send it to?"`
      : "Ask for their email — you don't have one on file for this conversation, so read back what they give you to check the spelling.",
    "YOU MUST GET AN EXPLICIT YES ON THE ADDRESS BEFORE SENDING. Only once they have confirmed it — or given you a different one — call resolve_service_link_contact with that address and email_confirmed=true. Calling it with email_confirmed=false (or leaving it out) does nothing except tell you to go and ask; it will not send.",
    "Never set email_confirmed=true for an address they haven't actually agreed to in their reply. If no existing contact matches, the tool CREATES one in our CRM, so a wrong address there is not just a misdirected link.",
    "Do not ask for name/role unless the tool responds with status 'need_more_info'. Once resolved, the link displays automatically — call get_service_link and do not paste any URL yourself.",
    recipientPhone
      ? `You also have a phone number on file (${recipientPhone}) — you may pass it as the phone argument to resolve_service_link_contact too, no need to ask for it separately.`
      : null,
    "",
    "── ENDING THE CONVERSATION ──",
    "Once everything above is resolved, don't just wrap up — ask once whether there's anything else they need help with (e.g. \"Is there anything else I can help you with?\"). If they raise something new, handle it, then ask again before ending.",
    "Only call end_conversation after they've confirmed they're all set (\"no\", \"that's all\", \"nope, thanks\", or equivalent) — this is the ONLY way to end the conversation; do not just stop responding or say goodbye without calling it, and do not call it in the same turn you first ask unless they already answered.",
    "Do not discuss pricing, contracts, or anything outside scheduling."
  );

  return lines.join("\n");
}

module.exports = { build };
