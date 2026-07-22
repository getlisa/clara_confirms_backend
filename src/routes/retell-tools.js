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
const stAppointments = require("../services/servicetrade-appointments");
const todosDb = require("../db/todos");
const logger = require("../utils/logger");
const { registerToolsForCompany } = require("../services/retell-tools");
const { parseCallbackTime } = require("../services/callback-time");
const { authenticate, getCompanyId: getCompanyIdFromToken } = require("../auth");

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
  const fromBody = req.body?.call?.metadata?.company_id;
  if (fromBody) return Number(fromBody);
  return null;
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

  const skip = new Set(["call", "execution_message", "name"]);
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

/**
 * Convert a naive local datetime string (no timezone suffix) from a given
 * timezone to a UTC ISO string.
 *
 * e.g. "2026-05-28T10:00:00" in "America/New_York" → "2026-05-28T14:00:00.000Z"
 *
 * Uses an iterative correction approach so DST transitions are handled correctly.
 */
function localToUTC(dateTimeStr, timezone) {
  // Normalise: ensure we have seconds, strip any existing Z/offset
  const clean = dateTimeStr.replace(/Z$|[+-]\d{2}:?\d{2}$/, "").padEnd(19, ":00").slice(0, 19);

  // Treat as UTC initially
  const naive = new Date(clean + "Z");

  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  // Iterate up to 3 times — converges in 1 pass for standard offsets, 2 at DST boundary
  let u = naive;
  for (let i = 0; i < 3; i++) {
    const localOfU = new Date(fmt.format(u) + "Z");
    const diff = naive.getTime() - localOfU.getTime();
    if (Math.abs(diff) < 1000) break;
    u = new Date(u.getTime() + diff);
  }
  return u.toISOString();
}

async function getCompanyTimezone(companyId) {
  const { rows } = await db.query(
    "SELECT default_timezone FROM companies WHERE id = $1",
    [companyId]
  );
  return rows[0]?.default_timezone || "America/New_York";
}

// ── GET JOB ───────────────────────────────────────────────────────────────────

/**
 * Both take a required `tz` (IANA zone, e.g. from getCompanyTimezone) so the
 * agent always reads out times in the company's/CRM's timezone — previously
 * these used no timeZone option at all and silently rendered in the server
 * process's local time, which could state the wrong time to a customer.
 */
function formatDate(iso, tz) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function formatDateTime(iso, tz) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * Real service(s) this job/appointment is for, from the synced ServiceTrade
 * appointment detail (see migrations/065_appointment_services.sql) — a
 * confirmed GET /appointment/{id} response carries `serviceRequests[]` with a
 * full serviceLine object, which is a materially better call-context signal
 * than a bare job number. Empty array when nothing resolved (e.g. no service
 * request was ever attached, or the sync hasn't picked it up yet) — callers
 * fall back to the job's own title/description/job_type in that case.
 */
async function fetchServicesForAppointment(companyId, appointmentId) {
  const { rows } = await db.query(
    `SELECT aps.description, aps.status, aps.completion, aps.estimated_price, aps.duration,
            sl.name AS service_line_name, sl.trade AS service_line_trade
       FROM appointment_services aps
       LEFT JOIN service_lines sl ON sl.id = aps.service_line_id
      WHERE aps.company_id = $1 AND aps.appointment_id = $2`,
    [companyId, appointmentId]
  );
  return rows.map((r) => ({
    service_line: [r.service_line_name, r.service_line_trade].filter(Boolean).join(" / ") || null,
    description: r.description || null,
    status: r.status || null,
    completion: r.completion || null,
    estimated_price: r.estimated_price ?? null,
    duration: r.duration ?? null,
  }));
}

/** Same as fetchServicesForAppointment but aggregated across every appointment on the job. */
async function fetchServicesForJob(companyId, jobId) {
  const { rows } = await db.query(
    `SELECT aps.description, aps.status, aps.completion, aps.estimated_price, aps.duration,
            sl.name AS service_line_name, sl.trade AS service_line_trade
       FROM appointment_services aps
       LEFT JOIN service_lines sl ON sl.id = aps.service_line_id
      WHERE aps.company_id = $1 AND aps.job_id = $2`,
    [companyId, jobId]
  );
  return rows.map((r) => ({
    service_line: [r.service_line_name, r.service_line_trade].filter(Boolean).join(" / ") || null,
    description: r.description || null,
    status: r.status || null,
    completion: r.completion || null,
    estimated_price: r.estimated_price ?? null,
    duration: r.duration ?? null,
  }));
}

function buildJobSummary(job, tz) {
  const c = job.customer || {};
  const t = job.technician || {};

  const activeAppointment = (job.appointments || [])
    .filter(a => a.status === "scheduled")
    .sort((a, b) => new Date(a.scheduled_start) - new Date(b.scheduled_start))[0] || null;

  return {
    job_id: job.id,
    title: job.title,
    description: job.description,
    job_type: job.job_type,
    status: job.status,
    scheduled_date: formatDate(job.scheduled_date, tz),

    customer: {
      name: c.full_name,
      phone: c.phone,
      email: c.email,
      address: [c.address_line1, c.city, c.state, c.zipcode].filter(Boolean).join(", ") || null,
    },

    technician: t.name ? {
      name: t.name,
      phone: t.phone,
    } : null,

    active_appointment: activeAppointment ? {
      appointment_id: activeAppointment.id,
      scheduled_start: formatDateTime(activeAppointment.scheduled_start, tz),
      scheduled_end: formatDateTime(activeAppointment.scheduled_end, tz),
      customer_confirmed: activeAppointment.customer_confirmed ?? false,
      technician_confirmed: activeAppointment.technician_confirmed ?? false,
      technician: activeAppointment.technician_name || null,
    } : null,

    has_active_appointment: !!activeAppointment,
  };
}

router.post("/get_job", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { job_id } = getArgs(req);
    if (!companyId || !job_id) return res.status(400).json({ error: "company_id and job_id are required" });

    const job = await jobsDb.getJobById(Number(job_id), companyId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const tz = await getCompanyTimezone(companyId);
    const services = await fetchServicesForJob(companyId, job.id);

    logger.info("Tool: get_job", { companyId, job_id, serviceCount: services.length, tz });
    return res.json({ job: { ...buildJobSummary(job, tz), services } });
  } catch (err) {
    logger.error("Tool get_job failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── GET APPOINTMENT ───────────────────────────────────────────────────────────

router.post("/get_appointment", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { appointment_id } = getArgs(req);
    if (!companyId || !appointment_id) return res.status(400).json({ error: "company_id and appointment_id are required" });

    const appointment = await jobsDb.getAppointmentById(Number(appointment_id), companyId);
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });

    // getAppointmentById doesn't carry job context — pull the parent job's
    // title/description/job_type as the fallback when no service resolves below.
    const { rows: jobRows } = await db.query(
      `SELECT title, description, job_type FROM jobs WHERE id = $1 AND company_id = $2`,
      [appointment.job_id, companyId]
    );
    const jobInfo = jobRows[0] || {};
    const tz = await getCompanyTimezone(companyId);
    const services = await fetchServicesForAppointment(companyId, appointment.id);

    logger.info("Tool: get_appointment", { companyId, appointment_id, serviceCount: services.length, tz });
    return res.json({
      appointment: {
        ...appointment,
        // Human-readable, company/CRM-timezone-localized versions of the raw
        // UTC scheduled_start/end above — this is what the agent should read
        // aloud, since a raw ISO timestamp is easy to misstate.
        scheduled_start_formatted: formatDateTime(appointment.scheduled_start, tz),
        scheduled_end_formatted: formatDateTime(appointment.scheduled_end, tz),
        job_title: jobInfo.title ?? null,
        job_description: jobInfo.description ?? null,
        job_type: jobInfo.job_type ?? null,
        services,
      },
    });
  } catch (err) {
    logger.error("Tool get_appointment failed", { error: err.message });
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

    logger.info("Tool: confirm_appointment", { companyId, appointment_id });
    return res.json({ success: true, appointment });
  } catch (err) {
    logger.error("Tool confirm_appointment failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

// ── RESCHEDULE APPOINTMENT ────────────────────────────────────────────────────

router.post("/reschedule_appointment", async (req, res) => {
  if (!verifyToolSecret(req, res)) return;
  try {
    const companyId = getCompanyId(req);
    const { appointment_id, scheduled_start, scheduled_end } = getArgs(req);
    if (!companyId || !appointment_id || !scheduled_start)
      return res.status(400).json({ error: "company_id, appointment_id and scheduled_start are required" });

    const tz = await getCompanyTimezone(companyId);
    const startUTC = localToUTC(scheduled_start, tz);
    const endUTC = scheduled_end
      ? localToUTC(scheduled_end, tz)
      : new Date(new Date(startUTC).getTime() + 2 * 60 * 60 * 1000).toISOString();

    const appointment = await jobsDb.updateAppointment(Number(appointment_id), companyId, {
      scheduled_start: startUTC,
      scheduled_end: endUTC,
    });
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });

    // Mirror to ServiceTrade (best-effort; platform is source of truth). Awaited
    // so serverless doesn't freeze before the PUT completes; never fails the tool.
    await stAppointments
      .mirrorRescheduleAppointment(companyId, appointment, { scheduledStart: startUTC, scheduledEnd: endUTC, retellCallId: req.body?.call?.call_id || null })
      .catch((err) => logger.error("crm-sync reschedule_appointment mirror failed", { error: err.message, companyId }));

    logger.info("Tool: reschedule_appointment", { companyId, appointment_id, scheduled_start, startUTC, tz });
    return res.json({ success: true, appointment });
  } catch (err) {
    logger.error("Tool reschedule_appointment failed", { error: err.message });
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
      `UPDATE jobs SET status = 'scheduled', updated_at = NOW() WHERE id = $1 AND company_id = $2 AND status = 'open'`,
      [job_id, companyId]
    );

    // Mirror to ServiceTrade: create the appointment there and stamp the id back.
    // Best-effort, awaited; never fails the tool (platform is source of truth).
    await stAppointments
      .mirrorCreateAppointment(companyId, appointment, Number(job_id), { scheduledStart: startUTC, scheduledEnd: endUTC, retellCallId: req.body?.call?.call_id || null })
      .catch((err) => logger.error("crm-sync create_appointment mirror failed", { error: err.message, companyId }));

    logger.info("Tool: create_appointment", { companyId, job_id, scheduled_start, startUTC, tz });
    return res.status(201).json({ success: true, appointment });
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

    // Mirror the new scheduled date to ServiceTrade (best-effort; awaited).
    await stAppointments
      .mirrorRescheduleJob(companyId, job, { scheduledDate: dateOnly, retellCallId: req.body?.call?.call_id || null })
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
    if (!companyId || !appointment_id || !scope || !reason)
      return res.status(400).json({ error: "company_id, appointment_id, scope and reason are required" });
    if (!["appointment_only", "entire_job"].includes(scope))
      return res.status(400).json({ error: "scope must be 'appointment_only' or 'entire_job'" });

    const retellCallId = req.body?.call?.call_id || null;

    const existing = await jobsDb.getAppointmentById(Number(appointment_id), companyId);
    if (!existing) return res.status(404).json({ error: "Appointment not found" });

    // ── Platform write (source of truth) ───────────────────────────────────
    const appointment = await jobsDb.updateAppointment(Number(appointment_id), companyId, {
      status: "cancelled",
      cancellation_reason: reason,
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
    }

    // ── Mirror to ServiceTrade (best-effort; awaited; never fails the tool) ──
    await stAppointments
      .mirrorCancelAppointment(companyId, appointment, { retellCallId })
      .catch((err) => logger.error("crm-sync cancel_appointment mirror failed", { error: err.message, companyId }));
    if (scope === "entire_job") {
      const { rows: jobRows } = await db.query(`SELECT external_ref, source FROM jobs WHERE id = $1 AND company_id = $2`, [existing.job_id, companyId]);
      await stAppointments
        .mirrorCancelJob(companyId, jobRows[0], { retellCallId })
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

    logger.info("Tool: cancel_appointment", { companyId, appointment_id, scope, reason });
    return res.json({ success: true, appointment, job, scope });
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

    logger.info("Tool: confirm_appointment_technician", { companyId, appointment_id });
    return res.json({ success: true, appointment });
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

    logger.info("Tool: get_quotation", { companyId, job_id });
    return res.json({ quotation: rows[0] });
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

    const rows = await serviceOpportunitiesDb.listByIdsForScheduling(companyId, ids);
    const serviceOpportunities = rows.map((r) => ({
      id: r.id,
      description: r.description,
      service_line: [r.service_line_name, r.service_line_trade].filter(Boolean).join(" / ") || null,
      why_recommended: [r.deficiency_name, r.deficiency_description].filter(Boolean).join(" — ") || null,
      estimated_price: r.estimated_price != null ? `$${r.estimated_price}` : null,
      recurring_service: recurrencePhrase(r.recurrence_frequency, r.recurrence_interval),
      requested_window: r.window_start
        ? { start: r.window_start, end: r.window_end }
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
  return rows[0] || null;
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
    const retellCallId = req.body?.call?.call_id;
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

    logger.info("Tool create_contact: recipient recorded", { companyId, retellCallId, contactId: String(contactId), reused: !!existing_contact_id });
    return res.json({ success: true, contact_id: String(contactId), email, message: "Recipient saved — the service link will be emailed after the call." });
  } catch (err) {
    logger.error("Tool create_contact failed", { error: err.message });
    return res.status(500).json({ error: "Failed to set service link recipient" });
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
