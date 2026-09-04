/**
 * Retell custom tool webhook endpoints.
 * Retell calls these during a live call when the subagent invokes a tool.
 *
 * Auth: x-tool-secret header must match RETELL_TOOL_SECRET env var.
 * company_id is extracted from call.metadata.company_id (set when call is created).
 */
const express = require("express");
const db = require("../db");
const jobsDb = require("../db/jobs");
const scheduledCallsDb = require("../db/scheduled-calls");
const serviceOpportunitiesDb = require("../db/service-opportunities");
const serviceLink = require("../services/servicetrade-service-link");
const serviceLinkMessagesDb = require("../db/service-link-messages");
const { getProviderForSource, resolveSlugForCompany } = require("../services/crm");
const { getWorkflow } = require("../confirmation-agent/workflows");
const slotHoldsDb = require("../db/slot-holds");
const technicianAvailability = require("../services/technician-availability");
const todosDb = require("../db/todos");
const chatLinksDb = require("../db/chat-links");
const confirmationEventsDb = require("../db/confirmation-events");
const { toE164 } = require("../utils/phone");
const logger = require("../utils/logger");
const { registerToolsForCompany } = require("../services/retell-tools");
const {
  buildJobConfirmationContext, toAppointmentsPayload,
} = require("../services/job-confirmation-context");
const { syncJobConfirmationStatus } = require("../services/job-confirmation-status");
const { parseCallbackTime } = require("../services/callback-time");
const { authenticate, getCompanyId: getCompanyIdFromToken } = require("../auth");
const {
  getCompanyTimezone, localToUTC, toOffsetISOString, formatSpokenDate, formatSpokenDateTime, formatSpokenDateOnly,
} = require("../utils/timezone");

const router = express.Router();

function verifyToolSecret(req, res) {
  const secret = process.env.RETELL_TOOL_SECRET;
  if (!secret) return true;
  // Accept both underscore and hyphen variants — some proxies (ngrok) normalise headers
  const received = req.headers["xtoolsecret"] || req.headers["x_tool_secret"] || req.headers["x-tool-secret"];
  if (received !== secret) {
    logger.warn("Tool: unauthorized request", { path: req.path, receivedHeaders: Object.keys(req.headers) });
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

function getCompanyId(req) {
  const fromQuery = req.query?.company_id;
  if (fromQuery) return Number(fromQuery);
  // Chat/SMS tool-webhook calls nest their payload under "chat" instead of
  // "call" — check both so every tool works identically regardless of channel.
  const fromBody = req.body?.call?.metadata?.company_id ?? req.body?.chat?.metadata?.company_id;
  if (fromBody) return Number(fromBody);
  return null;
}

/**
 * The Retell conversation identifier for this request — a real call_id for
 * voice/SMS, or a chat_id for a web-chat-link conversation. Used generically
 * both for CRM-mirror bookkeeping (works today for either) and for
 * chat_links state tracking (chatLinksDb.setState is a harmless no-op when
 * this is actually a call_id, since it just won't match any chat_links row).
 */
function getConversationId(req) {
  return req.body?.call?.call_id || req.body?.chat?.chat_id || null;
}

/**
 * Retell sends tool args in one of two formats depending on the node type:
 *   1. Nested:   { call: {...}, args: { job_id: "17" } }
 *   2. Flat:     { call: {...}, jobId: "17", execution_message: "..." }  ← conversation flow nodes
 *
 * This helper normalises both into a single flat snake_case object.
 */
function getArgs(req) {
  const raw = {};
  const source = (req.body?.args && typeof req.body.args === "object")
    ? req.body.args
    : req.body || {};

  const skip = new Set(["call", "chat", "execution_message", "name"]);
  for (const [k, v] of Object.entries(source)) {
    if (skip.has(k)) continue;
    const snake = k.replace(/([A-Z])/g, "_$1").toLowerCase();
    // Reject unresolved Retell template placeholders like "{{appointment_id}}"
    const isPlaceholder = typeof v === "string" && /^\{\{.*\}\}$/.test(v.trim());
    raw[snake] = isPlaceholder ? null : v;
  }
  return raw;
}

// ── Debug: log full raw body for every tool request ──────────────────────────
router.use((req, _res, next) => {
  logger.info("Tool request received", {
    path: req.path,
    query: req.query,
    headers: {
      x_tool_secret: req.headers["x_tool_secret"],
      xtoolsecret: req.headers["xtoolsecret"],
      "x-tool-secret": req.headers["x-tool-secret"],
      "content-type": req.headers["content-type"],
    },
    body: req.body,
  });
  next();
});

// ── Timezone helpers ──────────────────────────────────────────────────────────
// getCompanyTimezone/localToUTC/formatSpokenDate/formatSpokenDateTime now live
// in src/utils/timezone.js (single source of truth — see that file's header).

/**
 * Replace every raw UTC timestamp on an `apptRow`-shaped object with a
 * human-readable, company/CRM-timezone-localized spoken string — used by
 * every tool response that echoes an appointment back to the voice agent, so
 * a raw ISO timestamp never leaks (the agent should always speak a formatted
 * time, never both a raw and formatted version of the same field).
 */
function localizeAppointmentForAgent(appointment, tz) {
  if (!appointment) return appointment;
  const {
    scheduled_start, scheduled_end, customer_confirmed_at, technician_confirmed_at,
    rescheduled_to, created_at, updated_at, ...rest
  } = appointment;
  return {
    ...rest,
    scheduled_start: formatSpokenDateTime(scheduled_start, tz),
    scheduled_end: formatSpokenDateTime(scheduled_end, tz),
    customer_confirmed_at: formatSpokenDateTime(customer_confirmed_at, tz),
    technician_confirmed_at: formatSpokenDateTime(technician_confirmed_at, tz),
    rescheduled_to: formatSpokenDateTime(rescheduled_to, tz),
    created_at: formatSpokenDateTime(created_at, tz),
    updated_at: formatSpokenDateTime(updated_at, tz),
  };
}

/** Same idea as localizeAppointmentForAgent, for a `jobRow`-shaped object. */
function localizeJobForAgent(job, tz) {
  if (!job) return job;
  const { scheduled_date, scheduled_window_start, scheduled_window_end, created_at, updated_at, ...rest } = job;
  return {
    ...rest,
    scheduled_date: formatSpokenDateOnly(scheduled_date),
    scheduled_window_start: formatSpokenDateTime(scheduled_window_start, tz),
    scheduled_window_end: formatSpokenDateTime(scheduled_window_end, tz),
    created_at: formatSpokenDateTime(created_at, tz),
    updated_at: formatSpokenDateTime(updated_at, tz),
  };
}

// ── GET APPOINTMENTS ──────────────────────────────────────────────────────────

/**
 * The ONE way appointment data reaches the agent, for both voice and chat.
 *
 * Replaces the old `get_job` (job + all its appointments) and `get_appointment`
 * (one appointment by id). Job details are injected into the prompt as dynamic
 * variables instead, so this tool is purely about appointments:
 *   - job details are static for the length of a conversation → cheap to inject;
 *   - appointment data is not (it changes as the agent confirms, reschedules,
 *     cancels or creates), and Retell binds dynamic variables only once, so
 *     injecting it would hand the agent a snapshot that silently goes stale.
 *
 * Returns every upcoming appointment (earliest first, `next` = the lead) plus a
 * few past ones for "were you out here in June?". Only *_spoken timestamps are
 * exposed — a raw ISO string gets read aloud verbatim.
 */
router.post("/get_appointments", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { job_id } = getArgs(req);
    if (!companyId || !job_id) return res.status(400).json({ error: "company_id and job_id are required" });

    const ctx = await buildJobConfirmationContext(companyId, job_id);
    if (!ctx.ok) return res.status(ctx.status || 404).json({ error: ctx.error });

    const payload = toAppointmentsPayload(ctx);
    logger.info("Tool: get_appointments", {
      companyId, job_id, tz: ctx.tz,
      upcoming: payload.upcoming_count, unconfirmed: payload.unconfirmed_count, past: payload.past.length,
    });
    return res.json(payload);
  } catch (err) {
    logger.error("Tool get_appointments failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── CONFIRM APPOINTMENT ───────────────────────────────────────────────────────

router.post("/confirm_appointment", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { appointment_id } = getArgs(req);
    if (!companyId || !appointment_id) return res.status(400).json({ error: "company_id and appointment_id are required" });

    const appointment = await jobsDb.updateAppointment(Number(appointment_id), companyId, {
      customer_confirmed: true,
    });
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });

    // Chat state tracking — harmless no-op for voice/SMS (getConversationId
    // returns a call_id there, which won't match any chat_links row).
    const conversationId = getConversationId(req);
    await chatLinksDb.setState(conversationId, "confirmation_accepted").catch(() => {});

    // If the recipient was already captured earlier in this same call (agent
    // asked about the service link before confirming — unusual order but
    // possible), this is the moment that makes it sendable — fire it now
    // instead of waiting for the recipient-capture path to also check.
    const refs = await resolveConfirmationRefs(companyId, conversationId);
    if (refs) await maybeSendServiceLinkNow(companyId, conversationId, refs);

    // The job only becomes 'confirmed' once every upcoming appointment is.
    const jobStatus = await syncJobConfirmationStatus(companyId, appointment.job_id);

    // Ledger write for the daily report — mirrors the chat handlers exactly:
    // at the moment the DB write succeeds, not from post-call analysis (that
    // field is the model's own read of the transcript, the same intent-vs-
    // outcome gap the ledger exists to avoid).
    await confirmationEventsDb.recordSafe({
      companyId, eventType: "confirmed", channel: "voice", callType: "customer_confirmation",
      jobId: appointment.job_id, appointmentId: appointment.id,
      actorName: await resolveVoiceActorName(companyId, conversationId), source: conversationId,
    });

    // Tell the agent what's LEFT, so it knows whether to ask the
    // "confirm the others too?" question before wrapping up.
    const after = await buildJobConfirmationContext(companyId, appointment.job_id);
    const tz = await getCompanyTimezone(companyId);
    logger.info("Tool: confirm_appointment", {
      companyId, appointment_id, jobStatus,
      remainingUnconfirmed: after.ok ? after.counts.unconfirmed : null,
    });
    return res.json({
      success: true,
      appointment: localizeAppointmentForAgent(appointment, tz),
      ...(after.ok && {
        remaining_unconfirmed: after.counts.unconfirmed,
        all_upcoming_confirmed: after.counts.all_confirmed,
        remaining_appointments: after.appointments.upcoming
          .filter((a) => !a.customer_confirmed)
          .map((a) => ({
            appointment_id: a.appointment_id,
            scheduled_start: a.scheduled_start_spoken,
            service_line: a.service_line,
            technician: a.technician,
          })),
      }),
    });
  } catch (err) {
    logger.error("Tool confirm_appointment failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── CONFIRM SEVERAL APPOINTMENTS ON A JOB ─────────────────────────────────────

/**
 * Batch confirm, for the "would you like to confirm the other appointments as
 * well?" moment at the end of a job-centric conversation.
 *
 * Not a client-side loop over `confirm_appointment`: that tool has
 * `speak_after_execution: true`, so N calls make the agent narrate N times, and
 * models drop writes in long sequential tool chains. One call here is also one
 * job-status recompute and one service-link check.
 *
 * Requested ids that aren't confirmable come back in `skipped` with a reason
 * rather than as an error — a 4xx makes the agent apologise to the customer for
 * something that isn't a problem.
 */
router.post("/confirm_job_appointments", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { job_id, appointment_ids, confirm_all } = getArgs(req);
    if (!companyId || !job_id) return res.status(400).json({ error: "company_id and job_id are required" });

    const wantsAll = confirm_all === true || confirm_all === "true";
    // Accept a comma/space-separated string OR an array — models are inconsistent
    // about which they emit for a list-shaped parameter.
    const requestedIds = wantsAll
      ? []
      : (Array.isArray(appointment_ids) ? appointment_ids : String(appointment_ids ?? "").split(/[,\s]+/))
          .map((v) => String(v).trim())
          .filter(Boolean);
    if (!wantsAll && requestedIds.length === 0) {
      return res.status(400).json({ error: "Pass confirm_all=true or a non-empty appointment_ids list" });
    }

    const ctx = await buildJobConfirmationContext(companyId, job_id);
    if (!ctx.ok) return res.status(ctx.status || 404).json({ error: ctx.error });

    const upcomingById = new Map(ctx.appointments.upcoming.map((a) => [String(a.appointment_id), a]));
    const targets = [];
    const skipped = [];

    if (wantsAll) {
      targets.push(...ctx.appointments.upcoming.filter((a) => !a.customer_confirmed));
    } else {
      for (const id of requestedIds) {
        const appt = upcomingById.get(id);
        if (!appt) {
          // Either it belongs to a different job, or it's already past/cancelled.
          skipped.push({ appointment_id: id, reason: "not_an_upcoming_appointment_on_this_job" });
        } else if (appt.customer_confirmed) {
          skipped.push({ appointment_id: id, reason: "already_confirmed" });
        } else {
          targets.push(appt);
        }
      }
    }

    for (const appt of targets) {
      await jobsDb.updateAppointment(appt.appointment_id, companyId, { customer_confirmed: true });
    }

    const jobStatus = targets.length ? await syncJobConfirmationStatus(companyId, ctx.job.id) : ctx.job.status;

    if (targets.length) {
      const conversationId = getConversationId(req);
      await chatLinksDb.setState(conversationId, "confirmation_accepted").catch(() => {});
      const refs = await resolveConfirmationRefs(companyId, conversationId);
      if (refs) await maybeSendServiceLinkNow(companyId, conversationId, refs);

      // One ledger row PER appointment — see the chat confirm_job_appointments
      // handler for why a batch confirm is N outcomes, not one.
      const actorName = await resolveVoiceActorName(companyId, conversationId);
      await Promise.all(targets.map((a) => confirmationEventsDb.recordSafe({
        companyId, eventType: "confirmed", channel: "voice", callType: "customer_confirmation",
        jobId: ctx.job.id, appointmentId: a.appointment_id,
        actorName, source: conversationId,
      })));
    }

    const after = await buildJobConfirmationContext(companyId, ctx.job.id);
    logger.info("Tool: confirm_job_appointments", {
      companyId, job_id, confirmAll: wantsAll,
      confirmed: targets.length, skipped: skipped.length, jobStatus,
    });
    return res.json({
      success: true,
      confirmed: targets.map((a) => a.appointment_id),
      skipped,
      job_status: jobStatus,
      remaining_unconfirmed: after.ok ? after.counts.unconfirmed : null,
      all_upcoming_confirmed: after.ok ? after.counts.all_confirmed : null,
      ...(targets.length === 0 && {
        message: "Nothing left to confirm — those appointments were already confirmed.",
      }),
    });
  } catch (err) {
    logger.error("Tool confirm_job_appointments failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── RESCHEDULE APPOINTMENT ────────────────────────────────────────────────────

router.post("/reschedule_appointment", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { appointment_id, scheduled_start, scheduled_end } = getArgs(req);
    if (!companyId || !appointment_id)
      return res.status(400).json({ error: "company_id and appointment_id are required" });

    // The caller wants to reschedule but won't (or can't) commit to a time —
    // same "staff follow-up, no appointment write" escalation chat's
    // reschedule_appointment tool already had (see confirmation-agent/
    // actions.js's raiseRescheduleRequest). Voice had no equivalent: this
    // used to hard-400, which left no way to end the call in that case.
    if (!scheduled_start) {
      const before = await jobsDb.getAppointmentById(Number(appointment_id), companyId);
      await todosDb
        .create({
          companyId, callId: null,
          type: todosDb.TODO_TYPES.ASKED_FOR_RESCHEDULE,
          isTest: false, priority: "high",
          metadata: { source: "voice_call", call_id: String(getConversationId(req) || ""), job_id: String(before?.job_id ?? ""), appointment_id: String(appointment_id) },
        })
        .catch((err) => logger.warn("Tool reschedule_appointment: failed to raise ASKED_FOR_RESCHEDULE todo", { error: err.message, companyId }));
      logger.info("Tool: reschedule_appointment escalated (no time given)", { companyId, appointment_id });
      return res.json({ success: true, escalated: true, message: "Our team will follow up to find a time." });
    }

    const tz = await getCompanyTimezone(companyId);
    const startUTC = localToUTC(scheduled_start, tz);
    const endUTC = scheduled_end
      ? localToUTC(scheduled_end, tz)
      : new Date(new Date(startUTC).getTime() + 2 * 60 * 60 * 1000).toISOString();

    // Captured BEFORE the write — the ledger's "from" time.
    const before = await jobsDb.getAppointmentById(Number(appointment_id), companyId);

    let appointment;
    try {
      appointment = await jobsDb.updateAppointment(Number(appointment_id), companyId, {
        scheduled_start: startUTC,
        scheduled_end: endUTC,
        // A moved appointment is no longer confirmed — the customer agreed to the
        // OLD time. Leaving this true let a job read 'confirmed' for a slot nobody
        // ever agreed to, and kept the service-link gate open on stale consent.
        customer_confirmed: false,
        customer_confirmed_at: null,
      });
    } catch (err) {
      // See migrations/105_slot_holds.sql — appointments_inspectpoint_no_overlap
      // is the real backstop against a double-booked technician. Soft holds
      // (propose_reschedule_slots) make this rare but can't eliminate the race.
      if (slotHoldsDb.isSlotConflictError(err)) {
        return res.status(409).json({ success: false, conflict: true, error: "That time was just booked for this technician — please choose a different time." });
      }
      throw err;
    }
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });

    // Mirror to the CRM (best-effort; platform is source of truth). Awaited so
    // serverless doesn't freeze before the write completes; never fails the
    // tool. Dispatched by the appointment's own `source` — getProviderForSource
    // degrades to a no-op for a manual row or an unrecognized source.
    await getProviderForSource(appointment.source)
      ?.mirrorRescheduleAppointment(companyId, appointment, { scheduledStart: startUTC, scheduledEnd: endUTC, retellCallId: getConversationId(req) })
      .catch((err) => logger.error("crm-sync reschedule_appointment mirror failed", { error: err.message, companyId }));

    // Chat state tracking — harmless no-op for voice/SMS.
    await chatLinksDb.setState(getConversationId(req), "reschedule_pending_confirmation").catch(() => {});

    // Now unconfirmed again, so a 'confirmed' job must fall back to 'scheduled'.
    await syncJobConfirmationStatus(companyId, appointment.job_id);

    await confirmationEventsDb.recordSafe({
      companyId, eventType: "rescheduled", channel: "voice", callType: "customer_confirmation",
      jobId: appointment.job_id, appointmentId: appointment.id,
      actorName: await resolveVoiceActorName(companyId, getConversationId(req)), source: getConversationId(req),
      details: { from: before?.scheduled_start ?? null, to: startUTC },
    });

    // Best-effort: consume the hold this exact slot was offered under (if any —
    // see propose_reschedule_slots) and release the rest of this call's
    // remaining candidate holds now that one has been confirmed.
    const conversationId = getConversationId(req);
    if (appointment.technician_id && conversationId) {
      slotHoldsDb.consumeByWindow({ companyId, technicianId: appointment.technician_id, startsAt: startUTC, heldByToken: conversationId })
        .then(() => slotHoldsDb.releaseAllForToken({ companyId, heldByToken: conversationId }))
        .catch((err) => logger.warn("Tool reschedule_appointment: slot hold cleanup failed", { error: err.message, companyId }));
    }

    logger.info("Tool: reschedule_appointment", { companyId, appointment_id, scheduled_start, startUTC, tz });
    return res.json({ success: true, appointment: localizeAppointmentForAgent(appointment, tz) });
  } catch (err) {
    logger.error("Tool reschedule_appointment failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── PROPOSE RESCHEDULE SLOTS ──────────────────────────────────────────────────

const SLOT_SEARCH_HORIZON_DAYS = 14;

// Registered only when the company's workflow declares slotSuggestion:true
// (services/retell-tools.js's applyWorkflowCapabilities gates this the same
// way service_link_enabled gates resolve_service_link_contact/get_service_link)
// — but this route itself stays company-agnostic, same as every other tool
// route here; the gate lives entirely at registration time.
router.post("/propose_reschedule_slots", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { appointment_id, preferred_date } = getArgs(req);
    if (!companyId || !appointment_id)
      return res.status(400).json({ error: "company_id and appointment_id are required" });

    const appointment = await jobsDb.getAppointmentById(Number(appointment_id), companyId);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });
    if (!appointment.technician_id) {
      return res.json({
        success: false,
        error: "No technician is assigned to this appointment yet, so there is no calendar to search — ask the customer for a preferred time instead.",
      });
    }

    const tz = await getCompanyTimezone(companyId);
    const windowStart = preferred_date ? localToUTC(`${preferred_date}T00:00:00`, tz) : new Date().toISOString();
    const windowEnd = new Date(new Date(windowStart).getTime() + SLOT_SEARCH_HORIZON_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const slots = await technicianAvailability.offerSlots({
      companyId, technicianId: appointment.technician_id, heldByToken: getConversationId(req),
      windowStart, windowEnd, excludeAppointmentId: appointment.id,
    });

    logger.info("Tool: propose_reschedule_slots", { companyId, appointment_id, technicianId: appointment.technician_id, offered: slots.length });

    if (slots.length === 0) {
      return res.json({ success: true, slots: [], message: "No open times found in the next two weeks for this technician." });
    }

    return res.json({
      success: true,
      slots: slots.map((s) => ({
        // Round-trips straight into reschedule_appointment's own scheduled_start —
        // localToUTC there already strips this exact offset-ISO shape.
        scheduled_start: toOffsetISOString(s.starts_at, tz),
        scheduled_start_spoken: formatSpokenDateTime(s.starts_at, tz),
      })),
    });
  } catch (err) {
    logger.error("Tool propose_reschedule_slots failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── CREATE APPOINTMENT ────────────────────────────────────────────────────────

router.post("/create_appointment", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { job_id, scheduled_start, scheduled_end } = getArgs(req);
    if (!companyId || !job_id || !scheduled_start)
      return res.status(400).json({ error: "company_id, job_id and scheduled_start are required" });

    const tz = await getCompanyTimezone(companyId);
    const startUTC = localToUTC(scheduled_start, tz);
    const endUTC = scheduled_end
      ? localToUTC(scheduled_end, tz)
      : new Date(new Date(startUTC).getTime() + 2 * 60 * 60 * 1000).toISOString();

    const appointment = await jobsDb.createAppointment(companyId, Number(job_id), {
      scheduled_start: startUTC,
      scheduled_end: endUTC,
    });

    // Promote job status open → scheduled
    await db.query(
      `UPDATE jobs SET status = 'scheduled', updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status IN ('open', 'pending')`,
      [job_id, companyId]
    );
    // The new appointment is unconfirmed, so a job sitting at 'confirmed' has to
    // drop back to 'scheduled' — otherwise the confirmation sweep skips it and
    // this appointment never gets a confirmation call.
    await syncJobConfirmationStatus(companyId, Number(job_id));

    // Mirror to the CRM: create the appointment there and stamp the id back.
    // Best-effort, awaited; never fails the tool (platform is source of truth).
    // Dispatched by the JOB's source, not the appointment's — a freshly
    // created platform appointment has no CRM source of its own yet; "which
    // CRM to create it in" is a question about the job it belongs to.
    const { rows: createJobRows } = await db.query(`SELECT source FROM jobs WHERE id = $1 AND company_id = $2`, [job_id, companyId]);
    await getProviderForSource(createJobRows[0]?.source)
      ?.mirrorCreateAppointment(companyId, appointment, Number(job_id), { scheduledStart: startUTC, scheduledEnd: endUTC, retellCallId: getConversationId(req) })
      .catch((err) => logger.error("crm-sync create_appointment mirror failed", { error: err.message, companyId }));

    await confirmationEventsDb.recordSafe({
      companyId, eventType: "created", channel: "voice", callType: "customer_confirmation",
      jobId: Number(job_id), appointmentId: appointment.id,
      actorName: await resolveVoiceActorName(companyId, getConversationId(req)), source: getConversationId(req),
      details: { scheduled_start: startUTC },
    });

    logger.info("Tool: create_appointment", { companyId, job_id, scheduled_start, startUTC, tz });
    return res.status(201).json({ success: true, appointment: localizeAppointmentForAgent(appointment, tz) });
  } catch (err) {
    logger.error("Tool create_appointment failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── RESCHEDULE JOB ────────────────────────────────────────────────────────────

router.post("/reschedule_job", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { job_id, new_scheduled_date } = getArgs(req);
    if (!companyId || !job_id || !new_scheduled_date)
      return res.status(400).json({ error: "company_id, job_id and new_scheduled_date are required" });

    // new_scheduled_date is a date only (e.g. "2026-06-05") — no timezone conversion needed
    // Normalise to YYYY-MM-DD
    const dateOnly = new_scheduled_date.split("T")[0];

    const job = await jobsDb.updateJob(Number(job_id), companyId, { scheduled_date: dateOnly });
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Mirror the new scheduled date to the CRM (best-effort; awaited).
    await getProviderForSource(job.source)
      ?.mirrorRescheduleJob(companyId, job, { scheduledDate: dateOnly, retellCallId: getConversationId(req) })
      .catch((err) => logger.error("crm-sync reschedule_job mirror failed", { error: err.message, companyId }));

    logger.info("Tool: reschedule_job", { companyId, job_id, new_scheduled_date: dateOnly });
    return res.json({ success: true, job: { job_id: job.id, title: job.title, new_scheduled_date: dateOnly } });
  } catch (err) {
    logger.error("Tool reschedule_job failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── CANCEL APPOINTMENT ────────────────────────────────────────────────────────
// Full cancel: platform (source of truth) first, then mirror to ServiceTrade
// best-effort. Cancelling is fully actioned here (not escalated) — a low-priority
// APPOINTMENT_CANCELLED FYI todo is raised immediately so the team is aware.
// (handleCallAnalyzed suppresses the redundant ASKED_FOR_CANCELLATION todo for
// this call once it sees the cancelled_by_agent_call_id marker set below.)

router.post("/cancel_appointment", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { appointment_id, scope, reason } = getArgs(req);
    if (!companyId || !appointment_id || !scope)
      return res.status(400).json({ error: "company_id, appointment_id and scope are required" });
    if (!["appointment_only", "entire_job"].includes(scope))
      return res.status(400).json({ error: "scope must be 'appointment_only' or 'entire_job'" });
    // Required by default (ServiceTrade's workflow); a workflow whose
    // capabilities.cancellationReason is "optional" (InspectPoint) relaxes
    // this — mirrors routes/chat-links.js's identical relaxation.
    const workflow = getWorkflow(await resolveSlugForCompany(companyId));
    if (workflow.capabilities?.cancellationReason !== "optional" && !reason) {
      return res.status(400).json({ error: "reason is required" });
    }

    const retellCallId = getConversationId(req);

    const existing = await jobsDb.getAppointmentById(Number(appointment_id), companyId);
    if (!existing) return res.status(404).json({ error: "Appointment not found" });

    // ── Platform write (source of truth) ───────────────────────────────────
    const appointment = await jobsDb.updateAppointment(Number(appointment_id), companyId, {
      status: "cancelled",
      cancellation_reason: reason || null,
    });
    await db.query(
      `UPDATE appointments
          SET additional_information = COALESCE(additional_information, '{}'::jsonb)
                || jsonb_build_object('cancelled_by_agent_call_id', $1::text, 'cancellation_scope', $2::text),
              updated_at = NOW()
        WHERE id = $3 AND company_id = $4`,
      [retellCallId, scope, appointment.id, companyId]
    );

    let job = null;
    if (scope === "entire_job") {
      job = await jobsDb.updateJob(existing.job_id, companyId, { status: "cancelled" });
      await db.query(
        `UPDATE jobs
            SET additional_information = COALESCE(additional_information, '{}'::jsonb)
                  || jsonb_build_object('cancelled_by_agent_call_id', $1::text)
          WHERE id = $2 AND company_id = $3`,
        [retellCallId, existing.job_id, companyId]
      );
    } else {
      // Cancelling the one unconfirmed visit can leave the rest all confirmed,
      // which makes the job 'confirmed'. (Skipped for entire_job — the job is
      // 'cancelled' now and syncJobConfirmationStatus won't touch that status.)
      await syncJobConfirmationStatus(companyId, existing.job_id);
    }

    // ── Mirror to the CRM (best-effort; awaited; never fails the tool) ───────
    await getProviderForSource(appointment.source)
      ?.mirrorCancelAppointment(companyId, appointment, { retellCallId })
      .catch((err) => logger.error("crm-sync cancel_appointment mirror failed", { error: err.message, companyId }));
    if (scope === "entire_job") {
      const { rows: jobRows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [existing.job_id, companyId]);
      await getProviderForSource(jobRows[0]?.source)
        ?.mirrorCancelJob(companyId, jobRows[0], { retellCallId })
        .catch((err) => logger.error("crm-sync cancel_job mirror failed", { error: err.message, companyId }));
    }

    // ── Low-priority FYI todo — this call is fully actioned, not escalated ───
    await todosDb
      .create({
        companyId,
        callId: null, // no `calls` row exists yet mid-call; retell_call_id is in metadata
        type: todosDb.TODO_TYPES.APPOINTMENT_CANCELLED,
        isTest: false,
        priority: "low",
        metadata: { retell_call_id: retellCallId, appointment_id: String(appointment.id), job_id: String(existing.job_id), scope, reason },
      })
      .catch((err) => logger.warn("Failed to raise APPOINTMENT_CANCELLED todo", { error: err.message, companyId }));

    // Chat state tracking — harmless no-op for voice/SMS.
    await chatLinksDb.setState(retellCallId, "canceled").catch(() => {});

    await confirmationEventsDb.recordSafe({
      companyId, eventType: "cancelled", channel: "voice", callType: "customer_confirmation",
      jobId: existing.job_id, appointmentId: appointment.id,
      actorName: await resolveVoiceActorName(companyId, retellCallId), source: retellCallId,
      details: { reason, scope },
    });

    const tz = await getCompanyTimezone(companyId);
    logger.info("Tool: cancel_appointment", { companyId, appointment_id, scope, reason });
    return res.json({
      success: true,
      appointment: localizeAppointmentForAgent(appointment, tz),
      job: localizeJobForAgent(job, tz),
      scope,
    });
  } catch (err) {
    logger.error("Tool cancel_appointment failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── CONFIRM APPOINTMENT (TECHNICIAN) ─────────────────────────────────────────

router.post("/confirm_appointment_technician", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { appointment_id } = getArgs(req);
    if (!companyId || !appointment_id) return res.status(400).json({ error: "company_id and appointment_id are required" });

    const appointment = await jobsDb.updateAppointment(Number(appointment_id), companyId, {
      technician_confirmed: true,
    });
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });

    const tz = await getCompanyTimezone(companyId);
    logger.info("Tool: confirm_appointment_technician", { companyId, appointment_id });
    return res.json({ success: true, appointment: localizeAppointmentForAgent(appointment, tz) });
  } catch (err) {
    logger.error("Tool confirm_appointment_technician failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET QUOTATION ─────────────────────────────────────────────────────────────

router.post("/get_quotation", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { job_id } = getArgs(req);
    if (!companyId || !job_id) return res.status(400).json({ error: "company_id and job_id are required" });

    const { rows } = await db.query(
      `SELECT id, quote_number, title, notes AS description, status, total_amount, currency,
              valid_until, line_items, notes, created_at
       FROM quotations
       WHERE company_id = $1 AND job_id = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [companyId, Number(job_id)]
    );

    if (rows.length === 0) return res.status(404).json({ error: "Quotation not found for this job" });

    const tz = await getCompanyTimezone(companyId);
    const { valid_until, created_at, ...restQuote } = rows[0];
    logger.info("Tool: get_quotation", { companyId, job_id });
    return res.json({
      quotation: {
        ...restQuote,
        valid_until: formatSpokenDateOnly(valid_until), // DATE column — no time-of-day/tz component
        created_at: formatSpokenDateTime(created_at, tz),
      },
    });
  } catch (err) {
    logger.error("Tool get_quotation failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── SCHEDULE CALLBACK ─────────────────────────────────────────────────────────
// Live mid-call tool. Agent invokes this when the customer (or technician) asks
// to be called back at a specific time. Reuses scheduledCallsDb.scheduleCallback
// (same DB helper as the post-call analysis path) so the new row gets
// call_priority='callback' and inherits all parent context (phone, job_id, etc).
//
// Lookup: the in-flight scheduled_calls row by retell_call_id from call.call_id.
// The dispatcher writes retell_call_id at dial time (markCompleted), so by the
// time the agent calls a tool the row already has it populated.

/** Short recurrence phrase for tool output, e.g. "every 3 months". */
function recurrencePhrase(frequency, interval) {
  if (!frequency) return null;
  const n = Number(interval) || 1;
  const unit = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[frequency] || frequency;
  return n === 1 ? `recurring ${frequency}` : `every ${n} ${unit}s`;
}

/**
 * get_service_opportunities — READ tool for the Service Opportunity Follow Up agent.
 * Returns the open service opportunities for the CURRENT call as structured data.
 * The agent has no ids up front; it calls this to learn what to discuss. The
 * opportunity set is resolved from the in-flight scheduled_calls row (matched by
 * this Retell call id), whose synthetic job_id encodes the ids ("service_opportunity:3-4").
 */
router.post("/get_service_opportunities", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: "company_id is required" });

    const retellCallId = req.body?.call?.call_id;
    if (!retellCallId) return res.status(400).json({ error: "call.call_id missing from request" });

    const { rows: scRows } = await db.query(
      `SELECT job_id FROM scheduled_calls WHERE retell_call_id = $1 AND company_id = $2 LIMIT 1`,
      [retellCallId, companyId]
    );
    const jobKey = scRows[0]?.job_id || "";
    const ids = jobKey.startsWith("service_opportunity:")
      ? jobKey.slice("service_opportunity:".length).split("-").map(Number).filter(Number.isInteger)
      : [];
    if (ids.length === 0) {
      return res.json({ service_opportunities: [], count: 0 });
    }

    const tz = await getCompanyTimezone(companyId);
    const rows = await serviceOpportunitiesDb.listByIdsForScheduling(companyId, ids);
    const serviceOpportunities = rows.map((r) => ({
      id: r.id,
      description: r.description,
      service_line: [r.service_line_name, r.service_line_trade].filter(Boolean).join(" / ") || null,
      why_recommended: [r.deficiency_name, r.deficiency_description].filter(Boolean).join(" — ") || null,
      estimated_price: r.estimated_price != null ? `$${r.estimated_price}` : null,
      recurring_service: recurrencePhrase(r.recurrence_frequency, r.recurrence_interval),
      // Human-readable, company/CRM-timezone-localized — the agent reads this aloud.
      requested_window: r.window_start
        ? { start: formatSpokenDateTime(r.window_start, tz), end: formatSpokenDateTime(r.window_end, tz) }
        : null,
    }));

    logger.info("Tool: get_service_opportunities", { companyId, retellCallId, count: serviceOpportunities.length });
    return res.json({ service_opportunities: serviceOpportunities, count: serviceOpportunities.length });
  } catch (err) {
    logger.error("Tool get_service_opportunities failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

/**
 * book_service_opportunity — WRITE tool for the Service Opportunity Follow Up agent.
 * Books one service opportunity IN THE PLATFORM (sets status='booked' + records
 * booking metadata). Only registered when agent_can_make_changes=true.
 *
 * NOTE: ServiceTrade CRM write-back is intentionally deferred — serviceOpportunitiesDb
 * .markBooked is the seam where that future call will be added.
 */
router.post("/book_service_opportunity", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { service_opportunity_id, preferred_date, notes } = getArgs(req);
    if (!companyId || !service_opportunity_id) {
      return res.status(400).json({ error: "company_id and service_opportunity_id are required" });
    }

    const retellCallId = req.body?.call?.call_id || null;
    const booked = await serviceOpportunitiesDb.markBooked(Number(service_opportunity_id), companyId, {
      preferredDate: preferred_date || null,
      notes: notes || null,
      retellCallId,
    });
    if (!booked) return res.status(404).json({ error: "Service opportunity not found" });

    logger.info("Tool: book_service_opportunity", { companyId, service_opportunity_id, preferred_date });
    return res.json({ success: true, service_opportunity: booked });
  } catch (err) {
    logger.error("Tool book_service_opportunity failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

router.post("/schedule_callback", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: "company_id is required" });

    const { callback_time, reason } = getArgs(req);
    if (!callback_time) {
      return res.status(400).json({ error: "callback_time is required" });
    }

    const retellCallId = req.body?.call?.call_id;
    if (!retellCallId) {
      return res.status(400).json({ error: "call.call_id missing from request" });
    }

    // Find the in-flight scheduled_call row that triggered this Retell call.
    const { rows: scRows } = await db.query(
      `SELECT sc.*, j.scheduled_date AS job_due_date
       FROM scheduled_calls sc
       LEFT JOIN jobs j ON j.id::text = sc.job_id AND j.company_id = sc.company_id
       WHERE sc.retell_call_id = $1 AND sc.company_id = $2 LIMIT 1`,
      [retellCallId, companyId]
    );
    if (scRows.length === 0) {
      logger.warn("Tool schedule_callback: parent scheduled_call not found", { retellCallId, companyId });
      return res.status(404).json({ error: "No active call record found for this Retell call" });
    }
    const sc = scRows[0];

    const tz = await getCompanyTimezone(companyId);
    const callbackAt = parseCallbackTime(callback_time, tz);
    if (!callbackAt) {
      return res.status(400).json({
        error: `Could not parse callback_time '${callback_time}'. Use ISO 8601, 12h ('4pm'), 24h ('14:00'), or relative ('in 30 minutes').`,
      });
    }
    if (callbackAt <= new Date()) {
      return res.status(400).json({ error: "callback_time is in the past — pick a future time." });
    }

    const created = await scheduledCallsDb.scheduleCallback(sc, callbackAt.toISOString(), sc.job_due_date);
    if (!created) {
      return res.status(409).json({
        error: "Callback could not be scheduled. The requested time is after the job's due date, or a callback is already queued for this job.",
      });
    }

    if (reason) {
      await db.query(
        `UPDATE scheduled_calls SET job_description = COALESCE(NULLIF(job_description, ''), '') ||
            CASE WHEN job_description IS NULL OR job_description = '' THEN '' ELSE E'\\n' END ||
            'Callback reason: ' || $2,
            updated_at = NOW()
         WHERE id = $1`,
        [created.id, String(reason).slice(0, 500)]
      );
    }

    // Speakable confirmation in the customer's local time.
    const speakable = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short", hour: "numeric", minute: "2-digit", hour12: true,
    }).format(callbackAt);

    logger.info("Tool: schedule_callback", {
      companyId, parentId: sc.id, scheduledCallId: created.id,
      callbackAt: callbackAt.toISOString(), tz, jobId: sc.job_id, reason: reason || null,
    });

    return res.json({
      success: true,
      scheduled_callback: {
        scheduled_call_id: created.id,
        callback_time_utc: callbackAt.toISOString(),
        callback_time_local: speakable,
        timezone: tz,
      },
    });
  } catch (err) {
    logger.error("Tool schedule_callback failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── Service Link: contact search + recipient recording ───────────────────────
// Resolve the confirmation call's job → customer/location ServiceTrade ids so a
// new contact can be linked correctly and the service link points at the job.
/**
 * Who to credit for a voice outcome, for the confirmation_events ledger —
 * scheduled_calls' own recipient snapshot, same convention as the chat
 * ledger writes (src/confirmation-agent/tools/handlers/*). Best-effort: a
 * missing name just means the ledger row has no actor_name, never an error.
 */
async function resolveVoiceActorName(companyId, retellCallId) {
  const { rows } = await db.query(
    `SELECT recipient_name, customer_name FROM scheduled_calls WHERE retell_call_id = $1 AND company_id = $2 LIMIT 1`,
    [retellCallId, companyId]
  );
  return rows[0]?.recipient_name || rows[0]?.customer_name || null;
}

async function resolveConfirmationRefs(companyId, retellCallId) {
  const { rows } = await db.query(
    `SELECT sc.id AS scheduled_call_id, sc.job_id,
            j.external_ref AS job_ref, j.source AS job_source,
            cu.external_ref AS customer_ref
       FROM scheduled_calls sc
       LEFT JOIN jobs j       ON j.id::text = sc.job_id AND j.company_id = sc.company_id
       LEFT JOIN customers cu ON cu.id = j.customer_id
      WHERE sc.retell_call_id = $1 AND sc.company_id = $2 LIMIT 1`,
    [retellCallId, companyId]
  );
  if (rows[0]) return rows[0];

  // A web-chat-link conversation has no scheduled_calls row at all (it isn't
  // dispatched via the scheduler — the customer opens a token-based link
  // directly), so fall back to resolving job/customer context via chat_links.
  const { rows: chatRows } = await db.query(
    `SELECT NULL::int AS scheduled_call_id, cl.job_id::text AS job_id,
            j.external_ref AS job_ref, j.source AS job_source,
            cu.external_ref AS customer_ref
       FROM chat_links cl
       LEFT JOIN jobs j       ON j.id = cl.job_id AND j.company_id = cl.company_id
       LEFT JOIN customers cu ON cu.id = j.customer_id
      WHERE cl.retell_chat_id = $1 AND cl.company_id = $2 LIMIT 1`,
    [retellCallId, companyId]
  );
  return chatRows[0] || null;
}

/**
 * Whether ANY upcoming appointment on this conversation's job is confirmed —
 * the code-level gate for sending the service link live, mid-conversation,
 * instead of waiting for the post-call webhook. Deliberately checked in the DB
 * (not inferred from conversation/tool-call order) since that ordering is
 * prompt-driven and not reliable to depend on.
 *
 * Keyed on the JOB, not on `scheduled_calls.appointment_id`, for two reasons:
 *   - that column holds the appointment we DISPATCHED about, which in a
 *     job-centric conversation is often not the one the agent actually
 *     confirmed (the agent leads with the true next-upcoming);
 *   - requiring a scheduled_call_id made this return false for every chat
 *     session, since a web-chat link has no scheduled_calls row.
 * `refs.job_id` is populated from either source by resolveConfirmationRefs.
 */
async function isAppointmentConfirmed(companyId, refs) {
  const jobId = Number(refs?.job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) return false; // 'quotation:N' etc.
  const { rows } = await db.query(
    `SELECT 1
       FROM appointments a
      WHERE a.company_id = $1 AND a.job_id = $2
        AND a.status IN ('scheduled', 'confirmed', 'rescheduled')
        AND a.scheduled_start > NOW()
        AND a.customer_confirmed = true
      LIMIT 1`,
    [companyId, jobId]
  );
  return rows.length > 0;
}

/**
 * Send the service link right now if (a) the appointment is confirmed and
 * (b) a recipient has been captured — whichever of those two facts becomes
 * true LAST during the call triggers the actual send. Called from both
 * confirm_appointment and resolve_service_link_contact so either tool-call
 * order works, without depending on the prompt asking for things in a
 * specific sequence. sendRecordedServiceLink is itself idempotent (a `sent`
 * row is a no-op), so this can safely run more than once per call, and the
 * existing post-call postCallServiceLink remains a safety net if neither
 * hook fires in time.
 */
async function maybeSendServiceLinkNow(companyId, conversationId, refs) {
  if (!(await isAppointmentConfirmed(companyId, refs))) return { sent: false, reason: "not_confirmed_yet" };

  const row = await serviceLinkMessagesDb.getByRetellCallId(companyId, conversationId);
  if (!row || !row.contact_id || !row.email) return { sent: false, reason: "no_recipient_yet" };

  return serviceLink
    .sendRecordedServiceLink({ companyId, retellCallId: conversationId, scheduledCallId: refs.scheduled_call_id })
    .catch((err) => {
      logger.error("maybeSendServiceLinkNow: send threw", { error: err.message, companyId, conversationId });
      return { sent: false, reason: "error" };
    });
}

async function resolveJobLocationId(companyId, jobRef) {
  if (!jobRef) return null;
  const { rows } = await db.query(
    `SELECT payload->'location'->>'id' AS loc FROM servicetrade_jobs WHERE company_id = $1 AND servicetrade_id = $2 LIMIT 1`,
    [companyId, jobRef]
  );
  return rows[0]?.loc || null;
}

// POST /retell/tools/search_contact — find an existing contact (read-only).
router.post("/search_contact", async (req, res) => {
  try {
    if (!verifyToolSecret(req, res)) return;
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: "company_id missing" });
    const { query } = getArgs(req);
    if (!query) return res.status(400).json({ error: "query is required" });
    const contacts = await serviceLink.searchContacts(companyId, query);

    // Chat state tracking — harmless no-op for voice/SMS.
    await chatLinksDb.setState(getConversationId(req), "collecting_contact_info").catch(() => {});

    return res.json({ success: true, count: contacts.length, contacts });
  } catch (err) {
    logger.error("Tool search_contact failed", { error: err.message });
    return res.status(500).json({ error: "Failed to search contacts" });
  }
});

// POST /retell/tools/create_contact — record the service-link recipient (reuse an
// existing contact or create a new one). The email itself is sent post-call.
router.post("/create_contact", async (req, res) => {
  try {
    if (!verifyToolSecret(req, res)) return;
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: "company_id missing" });
    const retellCallId = getConversationId(req);
    if (!retellCallId) return res.status(400).json({ error: "call.call_id missing from request" });
    const { email, existing_contact_id, first_name, last_name, phone, role } = getArgs(req);
    if (!email) return res.status(400).json({ error: "email is required" });

    const refs = await resolveConfirmationRefs(companyId, retellCallId);
    if (!refs) return res.status(404).json({ error: "No scheduled call found for this call" });

    let contactId = existing_contact_id || null;
    if (!contactId) {
      const companyIds = /^\d+$/.test(String(refs.customer_ref)) ? [Number(refs.customer_ref)] : [];
      const locRaw = await resolveJobLocationId(companyId, refs.job_ref);
      const locationIds = locRaw && /^\d+$/.test(String(locRaw)) ? [Number(locRaw)] : [];
      const created = await serviceLink.createContact(companyId, {
        firstName: first_name, lastName: last_name, email, phone, role, companyIds, locationIds,
      });
      if (!created) return res.status(502).json({ error: "Failed to create contact in ServiceTrade" });
      contactId = created.id;
    }

    await serviceLinkMessagesDb.setRecipient({
      companyId,
      scheduledCallId: refs.scheduled_call_id,
      retellCallId,
      jobExternalRef: refs.job_ref || null,
      contactId: String(contactId),
      email,
    });

    // Chat state tracking — harmless no-op for voice/SMS.
    await chatLinksDb.setState(retellCallId, "collecting_contact_info").catch(() => {});

    logger.info("Tool create_contact: recipient recorded", { companyId, retellCallId, contactId: String(contactId), reused: !!existing_contact_id });
    return res.json({ success: true, contact_id: String(contactId), email, message: "Recipient saved — the service link will be emailed after the call." });
  } catch (err) {
    logger.error("Tool create_contact failed", { error: err.message });
    return res.status(500).json({ error: "Failed to set service link recipient" });
  }
});

// ── RESOLVE SERVICE LINK CONTACT ─────────────────────────────────────────────
// Replaces search_contact + create_contact (now disabled — see migration 071).
// Those two required the model to reliably sequence "search first, only ask
// for name/role if nothing found" itself — in practice it consistently asked
// for name/role upfront regardless of prompt/tool-description wording. This
// single tool moves that sequencing into our own code: it ALWAYS searches by
// email first, and uses an existing match if found — ignoring any name/role
// the model passed alongside — so a duplicate contact is never created
// regardless of what order the model gathered its questions in. Only when no
// match exists does it ask (via the "need_more_info" response status) for the
// model to collect name/role and call again.
router.post("/resolve_service_link_contact", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: "company_id missing" });
    const conversationId = getConversationId(req);
    if (!conversationId) return res.status(400).json({ error: "call/chat id missing from request" });
    const { email, email_confirmed, first_name, last_name, role, phone } = getArgs(req);
    if (!email) return res.status(400).json({ error: "email is required" });

    // Hard gate, deliberately ahead of the CRM search — mirrors the chat tool
    // (confirmation-agent/tools/handlers/resolve-service-link-contact.js).
    // An unconfirmed address isn't merely a bad send target: this endpoint
    // CREATES a ServiceTrade contact when nothing matches, so acting on a
    // misheard address writes a junk contact into the customer's CRM and mails
    // a job link to a stranger. Voice transcription makes that likelier here
    // than in chat, not less. The prompt asks too, but a prompt is advisory.
    //
    // Compared loosely: Retell sends tool arguments as JSON, but a boolean can
    // arrive as the string "true" depending on how the model emits it.
    if (email_confirmed !== true && String(email_confirmed).toLowerCase() !== "true") {
      logger.info("resolve_service_link_contact: refused, email not confirmed by the customer", {
        companyId, conversationId,
      });
      return res.json({
        status: "needs_email_confirmation",
        email,
        message:
          `Do not send yet. Read ${email} back to the customer and ask if it is the right address. ` +
          `Call this tool again with email_confirmed=true once they say yes, or with the corrected ` +
          `address they give you.`,
      });
    }

    const refs = await resolveConfirmationRefs(companyId, conversationId);
    if (!refs) return res.status(404).json({ error: "No scheduled call or chat found for this conversation" });
    // Service link is a ServiceTrade-only capability — no InspectPoint
    // equivalent exists at all. Defense-in-depth: voice tool registration
    // will withhold this tool once Phase 5 lands; this guard protects the
    // ServiceTrade-specific work below (a raw servicetrade_jobs lookup keyed
    // by job_ref as a servicetrade_id, plus real ServiceTrade API calls) in
    // the meantime.
    if (refs.job_source !== "servicetrade") {
      logger.info("Tool: resolve_service_link_contact — job is not from ServiceTrade; service link has no InspectPoint equivalent", { companyId, conversationId });
      return res.status(400).json({ error: "Service link is not available for this job's CRM" });
    }

    // Chat state tracking — harmless no-op for voice/SMS.
    await chatLinksDb.setState(conversationId, "collecting_contact_info").catch(() => {});

    // ALWAYS search by email first — regardless of whether the model also
    // supplied first_name/last_name/role on this same call.
    const candidates = await serviceLink.searchContacts(companyId, email);
    const exactMatch = candidates.find((c) => c.email && c.email.toLowerCase() === email.toLowerCase());
    const match = exactMatch || (candidates.length === 1 ? candidates[0] : null);

    let contactId, contactName, status, contactPhone;
    if (match) {
      contactId = match.id;
      contactName = [match.firstName, match.lastName].filter(Boolean).join(" ") || null;
      contactPhone = match.phone || null;
      status = "found";
    } else if (first_name || last_name) {
      const companyIds = /^\d+$/.test(String(refs.customer_ref)) ? [Number(refs.customer_ref)] : [];
      const locRaw = await resolveJobLocationId(companyId, refs.job_ref);
      const locationIds = locRaw && /^\d+$/.test(String(locRaw)) ? [Number(locRaw)] : [];
      const created = await serviceLink.createContact(companyId, {
        firstName: first_name, lastName: last_name, email, phone, role, companyIds, locationIds,
      });
      if (!created) return res.status(502).json({ error: "Failed to create contact in ServiceTrade" });
      contactId = created.id;
      contactName = [created.firstName, created.lastName].filter(Boolean).join(" ") || null;
      contactPhone = phone || null;
      status = "created";
    } else {
      logger.info("Tool: resolve_service_link_contact — no match, more info needed", { companyId, email });
      return res.json({ success: true, status: "need_more_info", email });
    }

    // Prefer whatever phone the model gave on THIS call (e.g. a number the
    // customer just stated) over the contact's on-file one.
    const normalizedPhone = toE164(phone) || toE164(contactPhone);

    await serviceLinkMessagesDb.setRecipient({
      companyId,
      scheduledCallId: refs.scheduled_call_id,
      retellCallId: conversationId,
      jobExternalRef: refs.job_ref || null,
      contactId: String(contactId),
      email,
      phone: normalizedPhone,
    });

    // If the appointment was already confirmed earlier in this same call,
    // this recipient capture is the moment that makes it sendable — fire it
    // now instead of waiting for the post-call webhook. link_sent tells the
    // agent (via the prompt) whether to say it's already been sent or that
    // it'll go out after the call.
    const sendResult = await maybeSendServiceLinkNow(companyId, conversationId, refs);

    logger.info("Tool: resolve_service_link_contact", { companyId, status, contactId: String(contactId), linkSent: sendResult?.sent });
    return res.json({ success: true, status, contact_id: String(contactId), name: contactName, email, link_sent: !!sendResult?.sent });
  } catch (err) {
    logger.error("Tool resolve_service_link_contact failed", { error: err.message });
    return res.status(500).json({ error: "Failed to resolve service link contact" });
  }
});

// ── REPORT CUSTOMER INTENT (chat only — see chat-links state machine) ───────
// Lets the agent signal a clear decision before the corresponding action tool
// actually fires (e.g. "wants_reschedule" before a date is collected). Harmless
// no-op for voice/SMS — chatLinksDb.setState just won't match any row there.
router.post("/report_customer_intent", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { intent } = getArgs(req);
    if (!companyId || !intent) return res.status(400).json({ error: "company_id and intent are required" });

    const stateByIntent = {
      wants_confirm: "confirmation_accepted",
      wants_reschedule: "reschedule_needed",
      wants_cancel: "canceled",
    };
    const state = stateByIntent[intent];
    if (state) {
      await chatLinksDb.setState(getConversationId(req), state).catch(() => {});
    }

    logger.info("Tool: report_customer_intent", { companyId, intent });
    return res.json({ success: true });
  } catch (err) {
    logger.error("Tool report_customer_intent failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET SERVICE LINK (chat only) ─────────────────────────────────────────────
// Fetch the live ServiceTrade service-link URL so the agent can paste it
// directly into the chat, in addition to the existing post-call email.
// URL mechanics (real captured values, per plan):
//   token = GET /api/token?jobId=<servicetrade_job_id>&userId=<servicetrade_user_id>
//   link  = https://app.servicetrade.com/customer/jobsummary?id=<token>
router.post("/get_service_link", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(400).json({ error: "company_id is required" });
    const conversationId = getConversationId(req);
    if (!conversationId) return res.status(400).json({ error: "call/chat id missing from request" });

    const refs = await resolveConfirmationRefs(companyId, conversationId);
    if (!refs?.job_ref) {
      return res.status(404).json({ error: "No ServiceTrade job found for this conversation" });
    }
    // Service link is a ServiceTrade-only capability — see the identical
    // guard in resolve_service_link_contact above for why this stays
    // defense-in-depth rather than relying solely on tool registration.
    if (refs.job_source !== "servicetrade") {
      logger.info("Tool: get_service_link — job is not from ServiceTrade; service link has no InspectPoint equivalent", { companyId, conversationId });
      return res.status(400).json({ error: "Service link is not available for this job's CRM" });
    }

    const minted = await serviceLink.mintServiceLinkUrl(companyId, refs.job_ref);
    if (!minted.ok) {
      logger.error("Tool get_service_link: mint failed", { companyId, error: minted.error, status: minted.status });
      return res.status(minted.status ? 502 : 503).json({ error: minted.error });
    }
    const url = minted.url;

    // Job name — for the frontend to render a preview card (title) rather
    // than just a bare URL. Best-effort; never blocks the link itself.
    const { rows: jobRows } = await db.query(
      `SELECT title FROM jobs WHERE id = $1 AND company_id = $2`,
      [refs.job_id, companyId]
    );
    const jobName = jobRows[0]?.title ?? null;

    // Chat state tracking — harmless no-op for voice/SMS.
    await chatLinksDb.setState(conversationId, "service_link_sent").catch(() => {});

    // Chat has no reliable "post-call" moment to defer the actual email to —
    // the session can stay open indefinitely (reschedule loops, the customer
    // just going quiet, etc.) — so for a chat session, send the recorded
    // recipient their ServiceTrade service-link email (+ text, if a phone is
    // on file) right now, the instant the agent shares it, rather than
    // waiting on a webhook that may fire much later or (for a still-open
    // chat) not at all yet. Voice's equivalent instant-send is triggered
    // from confirm_appointment/resolve_service_link_contact instead (gated
    // on the appointment actually being confirmed) — sendRecordedServiceLink
    // is idempotent, so it's harmless if both end up firing for the same
    // call.
    //
    // Awaited (not fire-and-forget): this may run on Vercel, where a
    // serverless function's execution can be frozen the instant its response
    // is sent — an un-awaited send here could silently never complete.
    // sendRecordedServiceLink is itself best-effort/never-throws, so awaiting
    // it just adds latency, not risk, to this tool's response.
    const isChatSession = !!(await chatLinksDb.getByRetellChatId(conversationId));
    let emailResult = null;
    if (isChatSession) {
      emailResult = await serviceLink
        .sendRecordedServiceLink({ companyId, retellCallId: conversationId, scheduledCallId: refs.scheduled_call_id ?? null })
        .catch((err) => {
          logger.error("Tool get_service_link: instant email send threw", { error: err.message, companyId, conversationId });
          return null;
        });
    }

    logger.info("Tool: get_service_link", { companyId, jobRef: refs.job_ref, isChatSession, emailResult });
    return res.json({ success: true, url, job_name: jobName });
  } catch (err) {
    logger.error("Tool get_service_link failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── REGISTER TOOLS (management) ───────────────────────────────────────────────
// POST /retell/tools/register — pushes tool definitions into the company's
// conversation flow nodes. Call this after provisioning or whenever tool URLs change.

router.post("/register", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyIdFromToken(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const result = await registerToolsForCompany(companyId);
    logger.info("Tools registered", { companyId, ...result });
    return res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("Tool registration failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
