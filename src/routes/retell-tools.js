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

function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function formatDateTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function buildJobSummary(job) {
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
    scheduled_date: formatDate(job.scheduled_date),

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
      scheduled_start: formatDateTime(activeAppointment.scheduled_start),
      scheduled_end: formatDateTime(activeAppointment.scheduled_end),
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

    logger.info("Tool: get_job", { companyId, job_id });
    return res.json({ job: buildJobSummary(job) });
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

    logger.info("Tool: get_appointment", { companyId, appointment_id });
    return res.json({ appointment });
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

    logger.info("Tool: reschedule_job", { companyId, job_id, new_scheduled_date: dateOnly });
    return res.json({ success: true, job: { job_id: job.id, title: job.title, new_scheduled_date: dateOnly } });
  } catch (err) {
    logger.error("Tool reschedule_job failed", { error: err.message });
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
