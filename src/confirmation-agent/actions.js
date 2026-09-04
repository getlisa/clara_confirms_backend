/**
 * The real DB/CRM logic behind confirm/reschedule/cancel/bulk-confirm/service-
 * link/end — extracted so it has exactly ONE implementation, called from the
 * LLM tool handlers (tools/handlers/*.js), whose `run()` is a thin wrapper:
 * pull args from config.configurable.ctx (preferring ctx.cardTriggerArgs on a
 * card-driven turn), call the core function here, return its JSON.
 *
 * Every core function takes a plain object (no `config`, no zod) so it has no
 * dependency on how it was invoked. Field names match `ctx`
 * (config.configurable.ctx) exactly, so a caller can spread `{...ctx, ...}`
 * straight in.
 *
 * There is no synthetic checkpoint injection anywhere in this codebase
 * anymore — every card action (confirm/reschedule/cancel/bulk-confirm/
 * decline-remaining/send-service-link) is a REAL, forced tool_choice turn
 * through the graph (routes/chat-links.js's runOneCardTriggerTurn), so the
 * checkpoint always reflects an actual model turn, never a faked one.
 */

const db = require("./../db");
const jobsDb = require("../db/jobs");
const chatLinksDb = require("../db/chat-links");
const todosDb = require("../db/todos");
const confirmationEventsDb = require("../db/confirmation-events");
const { getProviderForSource } = require("../services/crm");
const slotHoldsDb = require("../db/slot-holds");
const serviceLink = require("../services/servicetrade-service-link");
const serviceLinkMessagesDb = require("../db/service-link-messages");
const { syncJobConfirmationStatus } = require("../services/job-confirmation-status");
const { buildJobConfirmationContext } = require("../services/job-confirmation-context");
const { getCompanyTimezone, localToUTC } = require("../utils/timezone");
const { toE164 } = require("../utils/phone");
const { resolveConfirmerLabel, labelFromConfirmedBy } = require("./tools/confirmer-label");
const { maybeSendServiceLinkNow } = require("./tools/service-link-helpers");
const confirmerIdentitiesDb = require("../db/confirmer-identities");
const logger = require("../utils/logger");

// Sent as a real HumanMessage (via graph.invoke) to trigger the agent's own
// proactive "want to confirm the rest too?" turn right after a card-driven
// confirm/reschedule leaves other appointments unconfirmed — see
// graph/build.js's exclusiveTool wiring (the ONLY thing that binds
// propose_remaining_appointments to the model) and prompt.js's
// PROPOSE_REMAINING section. Filtered out of the visible transcript by
// index.js's toVisibleMessages.
const PROPOSE_REMAINING_TRIGGER = "(The customer just took an action on an appointment card. There are other still-unconfirmed upcoming appointments on this job — ask if they'd like to confirm those too.)";

// A card button click (confirm/reschedule/cancel/bulk-confirm/decline-remaining/
// send-service-link) routed through the agent for real — see
// routes/chat-links.js. Unlike PROPOSE_REMAINING_TRIGGER (one fixed string,
// no per-call data — the model composes everything itself), each of these
// needs to say WHICH tool this turn is for, so the marker carries that name.
// It deliberately carries no argument values: those travel out-of-band via
// config.configurable.ctx.cardTriggerArgs (see graph/build.js), which every
// promoted tool handler prefers over whatever the model relays — so the
// model's job is just "call the right tool," never "get the numbers right."
// Filtered out of the visible transcript by prefix (its content is per-call
// variable, so it cannot use the exact-string-equality filtering
// PROPOSE_REMAINING_TRIGGER above uses).
const CARD_TRIGGER_PREFIX = "[[CARD_TRIGGER]]";
function buildCardTrigger(tool) {
  return `${CARD_TRIGGER_PREFIX}${tool}`;
}
function parseCardTrigger(text) {
  if (typeof text !== "string" || !text.startsWith(CARD_TRIGGER_PREFIX)) return null;
  return text.slice(CARD_TRIGGER_PREFIX.length) || null;
}

/**
 * Confirm one appointment. Identical DB effects to confirm-appointment.js's
 * old inline body — see that file's history for the reasoning behind each
 * step (idempotent no-op on an already-confirmed row, jsonb-merge for
 * confirmed_by_label, the service-link send race).
 */
async function confirmAppointmentCore({ companyId, appointmentId, threadId, recipientContactId = null, jobRef = null, recipientName = null, confirmedBy = null }) {
  const existing = await jobsDb.getAppointmentById(Number(appointmentId), companyId);
  if (!existing) return { success: false, error: "Appointment not found" };
  if (existing.customer_confirmed === true) {
    logger.info("actions: confirmAppointmentCore — already confirmed, no-op", { companyId, appointmentId });
    return { success: true, appointment_id: existing.id, already_confirmed: true };
  }

  const appointment = await jobsDb.updateAppointment(Number(appointmentId), companyId, { customer_confirmed: true });
  if (!appointment) return { success: false, error: "Appointment not found" };

  const confirmedByLabel = await resolveConfirmerLabel(companyId, recipientContactId, confirmedBy);
  await db.query(
    `UPDATE appointments
        SET additional_information = COALESCE(additional_information, '{}'::jsonb)
              || jsonb_build_object('confirmed_by_thread_id', $1::text, 'confirmed_by_label', $2::text),
            updated_at = NOW()
      WHERE id = $3 AND company_id = $4`,
    [threadId, confirmedByLabel, appointment.id, companyId]
  );

  if (threadId) await chatLinksDb.setStateByToken(threadId, "confirmation_accepted").catch(() => {});
  const jobStatus = await syncJobConfirmationStatus(companyId, appointment.job_id);
  const linkSend = await maybeSendServiceLinkNow(companyId, threadId, jobRef, appointment.job_id);

  await confirmationEventsDb.recordSafe({
    companyId, eventType: "confirmed", channel: "chat", callType: "customer_confirmation",
    jobId: appointment.job_id, appointmentId: appointment.id,
    actorName: labelFromConfirmedBy(confirmedBy) || recipientName || null, source: threadId,
  });

  logger.info("actions: confirmAppointmentCore", {
    companyId, appointmentId, jobStatus, serviceLink: linkSend?.reason || (linkSend?.sent ? "sent" : null),
  });
  return {
    success: true, appointment_id: appointment.id, job_status: jobStatus,
    service_link_sent: linkSend?.sent === true,
    service_link_pending_reason: linkSend?.sent ? null : (linkSend?.reason ?? null),
  };
}

/** Batch-confirm — identical DB effects to confirm-job-appointments.js's old inline body. */
async function bulkConfirmCore({ companyId, jobId, threadId, recipientContactId = null, jobRef = null, recipientName = null, confirmedBy = null, confirmAll = false, appointmentIds = [] }) {
  const wantsAll = confirmAll === true;
  const requestedIds = wantsAll ? [] : (appointmentIds || []).map((v) => String(v).trim()).filter(Boolean);
  if (!wantsAll && requestedIds.length === 0) {
    return { success: false, error: "Pass confirmAll=true or a non-empty appointmentIds list" };
  }

  const ctx = await buildJobConfirmationContext(companyId, jobId);
  if (!ctx.ok) return { success: false, error: ctx.error };

  const upcomingById = new Map(ctx.appointments.upcoming.map((a) => [String(a.appointment_id), a]));
  const targets = [];
  const skipped = [];

  if (wantsAll) {
    targets.push(...ctx.appointments.upcoming.filter((a) => !a.customer_confirmed));
  } else {
    for (const id of requestedIds) {
      const appt = upcomingById.get(id);
      if (!appt) skipped.push({ appointment_id: id, reason: "not_an_upcoming_appointment_on_this_job" });
      else if (appt.customer_confirmed) skipped.push({ appointment_id: id, reason: "already_confirmed" });
      else targets.push(appt);
    }
  }

  if (targets.length) {
    const ids = targets.map((a) => a.appointment_id);
    await jobsDb.bulkConfirmAppointments(companyId, ids);
    const confirmedByLabel = await resolveConfirmerLabel(companyId, recipientContactId, confirmedBy);
    await db.query(
      `UPDATE appointments
          SET additional_information = COALESCE(additional_information, '{}'::jsonb)
                || jsonb_build_object('confirmed_by_thread_id', $1::text, 'confirmed_by_label', $2::text),
              updated_at = NOW()
        WHERE company_id = $3 AND id = ANY($4::int[])`,
      [threadId, confirmedByLabel, companyId, ids]
    );
  }

  if (targets.length && threadId) await chatLinksDb.setStateByToken(threadId, "confirmation_accepted").catch(() => {});
  // Stamped regardless of how many actually got confirmed — a bulk-confirm
  // call at all IS the customer's response to "want to confirm the rest?",
  // even if a race left nothing left to confirm by the time it landed.
  if (threadId) await chatLinksDb.markRemainingAddressed(threadId).catch(() => {});

  await Promise.all(targets.map((a) => confirmationEventsDb.recordSafe({
    companyId, eventType: "confirmed", channel: "chat", callType: "customer_confirmation",
    jobId: ctx.job.id, appointmentId: a.appointment_id,
    actorName: labelFromConfirmedBy(confirmedBy) || recipientName || null, source: threadId,
  })));

  const jobStatus = targets.length ? await syncJobConfirmationStatus(companyId, ctx.job.id) : ctx.job.status;
  const linkSend = targets.length ? await maybeSendServiceLinkNow(companyId, threadId, jobRef, ctx.job.id) : null;

  logger.info("actions: bulkConfirmCore", {
    companyId, jobId, confirmAll: wantsAll, confirmed: targets.length, skipped: skipped.length, jobStatus,
    serviceLink: linkSend?.reason || (linkSend?.sent ? "sent" : null),
  });

  return {
    success: true,
    confirmed: targets.map((a) => a.appointment_id),
    skipped,
    job_status: jobStatus,
    service_link_sent: linkSend?.sent === true,
    service_link_pending_reason: linkSend?.sent ? null : (linkSend?.reason ?? null),
    ...(targets.length === 0 && { message: "Nothing left to confirm — those appointments were already confirmed." }),
  };
}

/**
 * Move one appointment to a new time. Identical DB effects to
 * reschedule-appointment.js's old inline body. `scheduledStart` is REQUIRED
 * here — the "customer skipped picking a time" case is a different function
 * entirely (see raiseRescheduleRequest below), not this one with a null time,
 * to keep the daily report's completed-vs-requested distinction real.
 */
async function rescheduleAppointmentCore({ companyId, appointmentId, threadId, recipientName = null, confirmedBy = null, scheduledStart, scheduledEnd = null }) {
  const tz = await getCompanyTimezone(companyId);
  const startUTC = localToUTC(scheduledStart, tz);
  const endUTC = scheduledEnd
    ? localToUTC(scheduledEnd, tz)
    : new Date(new Date(startUTC).getTime() + 2 * 60 * 60 * 1000).toISOString();

  const before = await jobsDb.getAppointmentById(Number(appointmentId), companyId);

  let appointment;
  try {
    appointment = await jobsDb.updateAppointment(Number(appointmentId), companyId, {
      scheduled_start: startUTC, scheduled_end: endUTC, customer_confirmed: false, customer_confirmed_at: null,
    });
  } catch (err) {
    // The appointments_inspectpoint_no_overlap exclusion constraint (migrations/105)
    // is the real backstop against a double-booked technician — soft holds
    // (propose_reschedule_slots) reduce how often this happens but can't fully
    // eliminate the race, so this must be a normal re-offer path, not a 500.
    if (slotHoldsDb.isSlotConflictError(err)) {
      return { success: false, conflict: true, error: "That time was just booked for this technician — please choose a different time." };
    }
    throw err;
  }
  if (!appointment) return { success: false, error: "Appointment not found" };

  // Best-effort: if this exact window was offered (and held) via
  // propose_reschedule_slots, consume that hold and release any of this
  // conversation's other held candidates now that one has been confirmed.
  // A reschedule that never went through the propose tool simply has nothing
  // to consume here — not an error.
  if (appointment.technician_id && threadId) {
    slotHoldsDb.consumeByWindow({ companyId, technicianId: appointment.technician_id, startsAt: startUTC, heldByToken: threadId })
      .then(() => slotHoldsDb.releaseAllForToken({ companyId, heldByToken: threadId }))
      .catch((err) => logger.warn("actions: slot hold cleanup failed", { error: err.message, companyId }));
  }

  // Fire-and-forget: a best-effort CRM mirror whose own failure already raises
  // a CRM_SYNC todo and is never surfaced in this function's return value —
  // awaiting it just put a live CRM round trip in the customer's response
  // path for no benefit. Dispatched by the appointment's own `source` rather
  // than importing a concrete CRM module — getProviderForSource degrades to
  // null (no-op) for a manual row or an unrecognized source, same as before.
  getProviderForSource(appointment.source)
    ?.mirrorRescheduleAppointment(companyId, appointment, { scheduledStart: startUTC, scheduledEnd: endUTC, retellCallId: threadId })
    .catch((err) => logger.error("actions: reschedule mirror failed", { error: err.message, companyId }));

  await syncJobConfirmationStatus(companyId, appointment.job_id);

  await confirmationEventsDb.recordSafe({
    companyId, eventType: "rescheduled", channel: "chat", callType: "customer_confirmation",
    jobId: appointment.job_id, appointmentId: appointment.id,
    actorName: labelFromConfirmedBy(confirmedBy) || recipientName || null, source: threadId,
    details: { from: before?.scheduled_start ?? null, to: startUTC },
  });

  logger.info("actions: rescheduleAppointmentCore", { companyId, appointmentId, startUTC });
  return { success: true, appointment_id: appointment.id, scheduled_start: startUTC, scheduled_end: endUTC };
}

/**
 * The customer wants to reschedule but didn't (or wouldn't) pick a new time —
 * "like a reschedule request only from the manager behind the system" per
 * the product decision. NO appointment write, NO ledger row — this is a staff
 * action item, not a completed reschedule, and must not appear in the daily
 * report's Reschedules sheet (that distinction is the whole point of that
 * sheet reading from confirmation_events rather than a raw status flag).
 */
async function raiseRescheduleRequest({ companyId, jobId, appointmentId, threadId }) {
  await todosDb
    .create({
      companyId, callId: null,
      type: todosDb.TODO_TYPES.ASKED_FOR_RESCHEDULE,
      isTest: false, priority: "high",
      metadata: { source: "chat_card_skip", thread_id: threadId, job_id: String(jobId), appointment_id: String(appointmentId) },
    })
    .catch((err) => logger.warn("actions: failed to raise ASKED_FOR_RESCHEDULE todo", { error: err.message, companyId }));

  if (threadId) await chatLinksDb.setStateByToken(threadId, "reschedule_needed").catch(() => {});
  logger.info("actions: raiseRescheduleRequest", { companyId, jobId, appointmentId });
  return { success: true, escalated: true };
}

/** Cancel one appointment or the whole job. Identical DB effects to cancel-appointment.js's old inline body. */
async function cancelAppointmentCore({ companyId, appointmentId, threadId, recipientName = null, confirmedBy = null, scope, reason }) {
  const existing = await jobsDb.getAppointmentById(Number(appointmentId), companyId);
  if (!existing) return { success: false, error: "Appointment not found" };

  const appointment = await jobsDb.updateAppointment(Number(appointmentId), companyId, { status: "cancelled", cancellation_reason: reason });
  await db.query(
    `UPDATE appointments
        SET additional_information = COALESCE(additional_information, '{}'::jsonb)
              || jsonb_build_object('cancelled_by_agent_thread_id', $1::text, 'cancellation_scope', $2::text),
            updated_at = NOW()
      WHERE id = $3 AND company_id = $4`,
    [threadId, scope, appointment.id, companyId]
  );

  let job = null;
  if (scope === "entire_job") {
    job = await jobsDb.updateJob(existing.job_id, companyId, { status: "cancelled" });
  } else {
    await syncJobConfirmationStatus(companyId, existing.job_id);
  }

  // Fire-and-forget — same reasoning as the reschedule mirror above: best
  // effort, self-contained error handling, result never read here.
  getProviderForSource(appointment.source)
    ?.mirrorCancelAppointment(companyId, appointment, { retellCallId: threadId })
    .catch((err) => logger.error("actions: cancel mirror failed", { error: err.message, companyId }));
  if (scope === "entire_job") {
    const { rows: jobRows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [existing.job_id, companyId]);
    getProviderForSource(jobRows[0]?.source)
      ?.mirrorCancelJob(companyId, jobRows[0], { retellCallId: threadId })
      .catch((err) => logger.error("actions: cancel_job mirror failed", { error: err.message, companyId }));
  }

  await todosDb
    .create({
      companyId, callId: null,
      type: todosDb.TODO_TYPES.APPOINTMENT_CANCELLED,
      isTest: false, priority: "low",
      metadata: { thread_id: threadId, appointment_id: String(appointment.id), job_id: String(existing.job_id), scope, reason },
    })
    .catch((err) => logger.warn("actions: failed to raise APPOINTMENT_CANCELLED todo", { error: err.message, companyId }));

  if (threadId) await chatLinksDb.setStateByToken(threadId, "canceled").catch(() => {});
  // Only an entire_job cancel closes the chat outright (chat-cards-frontend.md
  // §7) — nothing left to offer on this job from the widget, so THAT satisfies
  // the "confirm the rest?" gate. A single-visit cancel (appointment_only)
  // must NOT stamp this: other still-untouched appointments on the job are
  // exactly what the gate exists to protect — nobody has been asked about
  // them just because one unrelated visit got cancelled.
  if (threadId && scope === "entire_job") await chatLinksDb.markRemainingAddressed(threadId).catch(() => {});

  await confirmationEventsDb.recordSafe({
    companyId, eventType: "cancelled", channel: "chat", callType: "customer_confirmation",
    jobId: existing.job_id, appointmentId: appointment.id,
    actorName: labelFromConfirmedBy(confirmedBy) || recipientName || null, source: threadId,
    details: { reason, scope },
  });

  logger.info("actions: cancelAppointmentCore", { companyId, appointmentId, scope, reason });
  return { success: true, appointment_id: appointment.id, scope, job_status: job?.status ?? null };
}

/**
 * Service link is a ServiceTrade-only capability — no InspectPoint equivalent
 * exists at all (not a different implementation, no implementation). This is
 * defense-in-depth: chat's CAPABILITY_TOOLS already withholds the tools that
 * call these functions when a workflow's capabilities.serviceLink is false,
 * so this guard should never actually trigger in normal operation — but the
 * ServiceTrade-specific work below (a raw `servicetrade_jobs` lookup keyed by
 * `jobRef` as a servicetrade_id, plus real ServiceTrade API calls) would
 * misbehave silently on a non-ServiceTrade job's numeric id if it were ever
 * reached any other way.
 */
async function isServiceTradeJob(companyId, jobId) {
  if (!jobId) return false;
  const { rows } = await db.query(`SELECT source FROM jobs WHERE id = $1 AND company_id = $2`, [jobId, companyId]);
  return rows[0]?.source === "servicetrade";
}

/**
 * The email step is implicitly "confirmed" here — this function only exists
 * to be called AFTER the UI's own Yes/No (or type-a-new-address) step, so
 * there is no `emailConfirmed` parameter the way the LLM tool has one: the
 * caller having reached this function at all IS the confirmation.
 *
 * Merges resolve-service-link-contact.js + get-service-link.js's old inline
 * bodies into one call, since the UI already did the "collect the right
 * email" step the LLM tool otherwise needs two round-trips for.
 */
async function sendServiceLinkCore({ companyId, jobId, threadId, jobRef = null, customerRef = null, email, firstName = null, lastName = null, role = null, phone = null }) {
  if (!(await isServiceTradeJob(companyId, jobId))) {
    logger.info("actions: sendServiceLinkCore — job is not from ServiceTrade; service link has no InspectPoint equivalent", { companyId, jobId });
    return { success: false, error: "Service link is not available for this job's CRM" };
  }
  const candidates = await serviceLink.searchContacts(companyId, email);
  const exactMatch = candidates.find((c) => c.email && c.email.toLowerCase() === email.toLowerCase());
  const match = exactMatch || (candidates.length === 1 ? candidates[0] : null);

  let contactId, contactName, status, contactPhone;
  if (match) {
    contactId = match.id;
    contactName = [match.firstName, match.lastName].filter(Boolean).join(" ") || null;
    contactPhone = match.phone || null;
    status = "found";
  } else if (firstName || lastName) {
    const companyIds = /^\d+$/.test(String(customerRef)) ? [Number(customerRef)] : [];
    const locRaw = jobRef
      ? (await db.query(
          `SELECT payload->'location'->>'id' AS loc FROM servicetrade_jobs WHERE company_id = $1 AND servicetrade_id = $2 LIMIT 1`,
          [companyId, jobRef]
        )).rows[0]?.loc
      : null;
    const locationIds = locRaw && /^\d+$/.test(String(locRaw)) ? [Number(locRaw)] : [];
    const created = await serviceLink.createContact(companyId, {
      firstName, lastName, email, phone, role, companyIds, locationIds,
    });
    if (!created) return { success: false, error: "Failed to create contact in ServiceTrade" };
    contactId = created.id;
    contactName = [created.firstName, created.lastName].filter(Boolean).join(" ") || null;
    contactPhone = phone || null;
    status = "created";
  } else {
    if (threadId) await chatLinksDb.setStateByToken(threadId, "collecting_contact_info").catch(() => {});
    logger.info("actions: sendServiceLinkCore — no match, more info needed", { companyId, email });
    return { success: false, status: "need_more_info", email, fields_needed: ["first_name", "last_name"] };
  }

  const normalizedPhone = toE164(phone) || toE164(contactPhone);
  await serviceLinkMessagesDb.setRecipient({
    companyId, scheduledCallId: null, retellCallId: threadId,
    jobExternalRef: jobRef || null, contactId: String(contactId), email, phone: normalizedPhone,
  });

  const sendResult = await maybeSendServiceLinkNow(companyId, threadId, jobRef, jobId);
  logger.info("actions: sendServiceLinkCore", { companyId, status, contactId: String(contactId), linkSent: sendResult?.sent });

  return { success: true, status, contact_id: String(contactId), name: contactName, email, link_sent: !!sendResult?.sent };
}

/**
 * The ServiceTrade contactId to mint a customer-facing service-link URL
 * against — "the contact this conversation is actually with." Tries, in
 * order: (1) a service_link_messages row already resolved for this thread
 * (its contact_id is already a ServiceTrade id, set by sendServiceLinkCore's
 * contact search/create — no extra lookup needed), (2) the platform contact
 * the link was nominated to, (3) the job's ServiceTrade primary contact.
 * Returns null if none resolve — mintServiceLinkUrl then falls back to the
 * company-level userId method rather than hard-failing.
 */
async function resolveServiceLinkContactRef(companyId, threadId, recipientContactId, jobId) {
  if (threadId) {
    const row = await serviceLinkMessagesDb.getByRetellCallId(companyId, threadId).catch(() => null);
    if (row?.contact_id) return row.contact_id;
  }
  if (recipientContactId) {
    const { rows } = await db.query(`SELECT external_ref FROM contacts WHERE id = $1 AND company_id = $2`, [recipientContactId, companyId]);
    if (rows[0]?.external_ref) return rows[0].external_ref;
  }
  if (jobId) {
    const { rows } = await db.query(
      `SELECT c.external_ref FROM jobs j JOIN contacts c ON c.id = j.primary_contact_id
        WHERE j.id = $1 AND j.company_id = $2`,
      [jobId, companyId]
    );
    if (rows[0]?.external_ref) return rows[0].external_ref;
  }
  return null;
}

/**
 * Re-fetch/mint the live service-link URL for a job whose recipient was
 * already resolved (a prior sendServiceLinkCore call, or the earlier
 * per-recipient dispatch at scheduling time) — genuinely distinct from
 * sendServiceLinkCore, which starts from an email and resolves a contact
 * first. Identical DB effects to get-service-link.js's old inline body.
 */
async function mintServiceLinkCore({ companyId, jobId, jobRef, threadId, recipientContactId = null }) {
  if (!jobRef) return { success: false, error: "No ServiceTrade job found for this conversation" };
  if (!(await isServiceTradeJob(companyId, jobId))) {
    logger.info("actions: mintServiceLinkCore — job is not from ServiceTrade; service link has no InspectPoint equivalent", { companyId, jobId });
    return { success: false, error: "Service link is not available for this job's CRM" };
  }

  const contactExternalRef = await resolveServiceLinkContactRef(companyId, threadId, recipientContactId, jobId);
  const minted = await serviceLink.mintServiceLinkUrl(companyId, jobRef, contactExternalRef);
  if (!minted.ok) {
    logger.error("actions: mintServiceLinkCore mint failed", { companyId, error: minted.error, status: minted.status });
    return { success: false, error: minted.error };
  }

  const { rows: jobRows } = await db.query(`SELECT title FROM jobs WHERE id = $1 AND company_id = $2`, [jobId, companyId]);
  const jobName = jobRows[0]?.title ?? null;

  if (threadId) await chatLinksDb.setStateByToken(threadId, "service_link_sent").catch(() => {});
  logger.info("actions: mintServiceLinkCore", { companyId, jobId });
  return { success: true, url: minted.url, job_name: jobName };
}

/**
 * The customer was asked "want to confirm the rest too?" (via the real agent
 * turn — propose_remaining_appointments) and said no. No appointment write —
 * this only stamps that the question was asked and answered, so
 * POST /:token/end can proceed. The caller injects the usual synthetic turn
 * afterward (tool: "decline_remaining_appointments") so it's visible in the
 * transcript exactly like every other card action.
 */
async function declineRemainingCore({ companyId, threadId }) {
  if (threadId) await chatLinksDb.markRemainingAddressed(threadId).catch(() => {});
  logger.info("actions: declineRemainingCore", { companyId, threadId });
  return { success: true };
}

/**
 * Record who is actually confirming for this chat session — captured once
 * (a re-submit just overwrites) and reused for every subsequent action in
 * the conversation via ctx.confirmedBy (confirmation-agent/index.js's
 * resolveConfirmedBy). Session/link-level identity, not a per-appointment
 * stamp — no appointment write here.
 */
async function captureConfirmerIdentityCore({ threadId, firstName, lastName, role, phone, email = null }) {
  if (!threadId) return { success: false, error: "No active chat session" };
  await confirmerIdentitiesDb.upsert(threadId, { firstName, lastName, role, phone, email });
  logger.info("actions: captureConfirmerIdentityCore", { threadId, role });
  return { success: true, first_name: firstName, last_name: lastName, role, phone, email: email ?? null };
}

module.exports = {
  PROPOSE_REMAINING_TRIGGER,
  CARD_TRIGGER_PREFIX,
  buildCardTrigger,
  parseCardTrigger,
  confirmAppointmentCore,
  bulkConfirmCore,
  rescheduleAppointmentCore,
  raiseRescheduleRequest,
  cancelAppointmentCore,
  sendServiceLinkCore,
  mintServiceLinkCore,
  declineRemainingCore,
  captureConfirmerIdentityCore,
};
