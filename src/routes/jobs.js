/**
 * Jobs & Appointments routes
 *
 * GET    /jobs                        list jobs
 * GET    /jobs/:id                    job detail + appointments + quotations
 * POST   /jobs                        create job
 * PATCH  /jobs/:id                    update job
 *
 * GET    /jobs/:id/appointments       list all appointments for a job
 * POST   /jobs/:id/appointments       create appointment for a job
 * GET    /appointments/:id            single appointment
 * PATCH  /appointments/:id            update appointment (status, confirmations, etc.)
 */

const express = require("express");
const jobsDb = require("../db/jobs");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");
const { getCompanyTimezone, localToUTC, localizeFields, localizeRows } = require("../utils/timezone");
const { syncJobConfirmationStatus } = require("../services/job-confirmation-status");
const scheduler = require("../services/scheduler");
const callSettingsDb = require("../db/call-settings");

const router = express.Router();
router.use(authenticate);

// scheduled_date/valid_until are DATE-only columns — never passed through these.
const JOB_TZ_FIELDS   = ["scheduled_window_start", "scheduled_window_end", "created_at", "updated_at"];
const APPT_TZ_FIELDS  = ["scheduled_start", "scheduled_end", "customer_confirmed_at", "technician_confirmed_at", "rescheduled_to", "created_at", "updated_at"];
const QUOTE_TZ_FIELDS = ["created_at"];

function localizeJob(job, tz) {
  if (!job) return job;
  const out = localizeFields(job, tz, JOB_TZ_FIELDS);
  if (Array.isArray(job.appointments)) out.appointments = localizeRows(job.appointments, tz, APPT_TZ_FIELDS);
  if (Array.isArray(job.quotations))   out.quotations   = localizeRows(job.quotations, tz, QUOTE_TZ_FIELDS);
  if (job.active_appointment!=null) out.active_appointment = localizeFields(job.active_appointment, tz, ["scheduled_start", "scheduled_end"]);
  return out;
}

function localizeAppointment(appointment, tz) {
  return localizeFields(appointment, tz, APPT_TZ_FIELDS);
}

// ── Jobs ──────────────────────────────────────────────────────────────────────

// Must be declared BEFORE /:id to avoid Express matching "technicians" as an id param
router.get("/technicians", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const db = require("../db");
    const { is_available } = req.query;
    const conditions = ["company_id = $1", "is_active = true"];
    const values = [companyId];

    if (is_available === "true")  conditions.push("is_available = true");
    if (is_available === "false") conditions.push("is_available = false");

    const result = await db.query(
      `SELECT id, first_name, last_name, first_name || ' ' || last_name AS name,
              email, phone, is_available, additional_information
       FROM technicians
       WHERE ${conditions.join(" AND ")}
       ORDER BY first_name, last_name`,
      values
    );
    return res.json({ technicians: result.rows });
  } catch (err) {
    logger.error("GET /jobs/technicians failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load technicians" });
  }
});

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const {
      status, job_type, customer_id, technician_id, location_id,
      scheduled_date_from, scheduled_date_to,
      due_soon, confirmed,
      search, limit, offset,
    } = req.query;

    // scheduled_date_from/to need the company timezone up front — they filter
    // on appointment scheduled_start (a timestamptz), compared as a LOCAL date,
    // same convention the confirmation sweep uses for its date windows.
    const tz = await getCompanyTimezone(companyId);

    // status/job_type/customer_id/location_id all accept a single value or a
    // comma-separated list — jobsDb.listJobs handles both the same way, so a
    // single status=scheduled request behaves exactly as it always has.
    const jobs = await jobsDb.listJobs(companyId, {
      status:            status || undefined,
      jobType:           job_type || undefined,
      customerId:        customer_id || undefined,
      technicianId:      technician_id ? Number(technician_id) : undefined,
      locationId:        location_id || undefined,
      scheduledDateFrom: scheduled_date_from || undefined,
      scheduledDateTo:   scheduled_date_to || undefined,
      tz,
      dueSoonDays:       due_soon != null ? Number(due_soon) : undefined,
      confirmed:         confirmed === "true" ? true : confirmed === "false" ? false : undefined,
      search:            search || undefined,
      limit:             limit  ? Math.min(Number(limit), 200) : 50,
      offset:            offset ? Number(offset) : 0,
    });

    // const jobsWithAppointments = jobs.filter((j) => j.active_appointment != null);
    return res.json({ jobs: jobs.map((j) => localizeJob(j, tz)) });
  } catch (err) {
    logger.error("GET /jobs failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load jobs" });
  }
});

// Must be declared BEFORE /:id — same reasoning as /technicians above.
router.get("/job-types", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const jobTypes = await jobsDb.listJobTypes(companyId);
    return res.json({ job_types: jobTypes });
  } catch (err) {
    logger.error("GET /jobs/job-types failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load job types" });
  }
});

/**
 * POST /jobs/bulk-send-confirmation
 * Body: { items: [{ type: "job"|"appointment", id: number }, ...] }
 *
 * Tenant-selected "send confirmation" for specific inspections (manual mode —
 * see call_settings.auto_schedule_enabled). Queues one scheduled_calls row per
 * job through the SAME per-job enqueue logic the nightly sweep uses
 * (scheduler.enqueueJobConfirmation), so channel resolution, contact gates
 * and dedupe never diverge between the automatic and manual paths.
 *
 * Unlike the requested v2 §3 contract, this QUEUES rather than sends — the
 * dispatcher (cron or a manual poke) still fires it, respecting office hours
 * and concurrency caps — so the response reports queued/skipped/failed per
 * item, not a token/sent_via pair (those only exist once actually dispatched).
 *
 * {type:"appointment"} items collapse to their parent job — one conversation
 * now covers every upcoming appointment on a job, so there's nothing to
 * address at the individual-appointment level.
 */
router.post("/bulk-send-confirmation", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array of { type, id }" });
    }

    const db = require("../db");
    const jobIds = new Map(); // jobId -> the first item that resolved to it (for reporting)
    const results = [];

    for (const item of items) {
      const { type, id } = item || {};
      if (type === "job" && id != null) {
        if (!jobIds.has(Number(id))) jobIds.set(Number(id), item);
      } else if (type === "appointment" && id != null) {
        const { rows } = await db.query(
          `SELECT job_id FROM appointments WHERE id = $1 AND company_id = $2`,
          [id, companyId]
        );
        const jobId = rows[0]?.job_id;
        if (!jobId) {
          results.push({ type, id, status: "failed", reason: "appointment_not_found" });
          continue;
        }
        // Collapsing to the parent job: if that job is already in the batch
        // (as its own item or via another appointment), don't queue it twice —
        // just note this item resolved to the same job.
        if (!jobIds.has(jobId)) jobIds.set(jobId, item);
      } else {
        results.push({ type, id, status: "failed", reason: "invalid_item — type must be 'job' or 'appointment' with a numeric id" });
      }
    }

    const callSettings = await callSettingsDb.getByCompanyId(companyId);
    const { rows: coRows } = await db.query(`SELECT default_timezone, sms_status FROM companies WHERE id = $1`, [companyId]);
    const tz = coRows[0]?.default_timezone || "America/New_York";
    const smsLive = coRows[0]?.sms_status === "live";

    for (const [jobId, item] of jobIds) {
      // One entry per resolved recipient (the customer and/or their opted-in
      // confirmation contacts) — a job with 2 recipients reports 2 results.
      const recipientResults = await scheduler.enqueueJobConfirmation(companyId, jobId, {
        callType: "customer_confirmation",
        callSettings, tz, smsLive,
        callPriority: "high",
      });
      for (const result of recipientResults) {
        results.push({
          type: "job", id: jobId, requestedAs: item.type,
          status: result.status,
          ...(result.recipientContactId != null && { recipient_contact_id: result.recipientContactId }),
          ...(result.reason && { reason: result.reason }),
          ...(result.channel && { channel: result.channel }),
          ...(result.linkDelivery && { link_delivery: result.linkDelivery }),
          ...(result.scheduled_call_id && { scheduled_call_id: result.scheduled_call_id }),
          ...(result.scheduled_at && { scheduled_at: result.scheduled_at }),
        });
      }
    }

    logger.info("POST /jobs/bulk-send-confirmation", {
      companyId, requested: items.length, jobs: jobIds.size,
      queued: results.filter((r) => r.status === "queued").length,
    });

    return res.status(200).json({ results });
  } catch (err) {
    logger.error("POST /jobs/bulk-send-confirmation failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send confirmations" });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const job = await jobsDb.getJobById(Number(req.params.id), companyId);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const tz = await getCompanyTimezone(companyId);
    return res.json({ job: localizeJob(job, tz) });
  } catch (err) {
    logger.error("GET /jobs/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load job" });
  }
});

router.post("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { customer_id } = req.body;
    if (!customer_id) return res.status(400).json({ error: "customer_id is required" });

    const job = await jobsDb.createJob(companyId, req.body);
    const tz = await getCompanyTimezone(companyId);
    return res.status(201).json({ job: localizeJob(job, tz) });
  } catch (err) {
    logger.error("POST /jobs failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create job" });
  }
});

router.patch("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    if (Object.keys(req.body).length === 0)
      return res.status(400).json({ error: "No fields to update" });

    const job = await jobsDb.updateJob(Number(req.params.id), companyId, req.body);
    if (!job) return res.status(404).json({ error: "Job not found" });

    const tz = await getCompanyTimezone(companyId);
    return res.json({ job: localizeJob(job, tz) });
  } catch (err) {
    logger.error("PATCH /jobs/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update job" });
  }
});

// PATCH /jobs/:id/reschedule — update job's scheduled_date (from UI or Retell tool)
router.patch("/:id/reschedule", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { scheduled_date } = req.body;
    if (!scheduled_date) return res.status(400).json({ error: "scheduled_date is required" });

    const dateOnly = scheduled_date.split("T")[0];
    const job = await jobsDb.updateJob(Number(req.params.id), companyId, { scheduled_date: dateOnly });
    if (!job) return res.status(404).json({ error: "Job not found" });

    logger.info("Job rescheduled", { jobId: req.params.id, companyId, scheduled_date: dateOnly });
    const tz = await getCompanyTimezone(companyId);
    return res.json({ job: localizeJob(job, tz) });
  } catch (err) {
    logger.error("PATCH /jobs/:id/reschedule failed", { error: err.message });
    return res.status(500).json({ error: "Failed to reschedule job" });
  }
});

// ── Appointments (nested under job) ──────────────────────────────────────────

router.get("/:id/appointments", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const appointments = await jobsDb.listAppointmentsByJob(
      Number(req.params.id), companyId
    );
    const tz = await getCompanyTimezone(companyId);
    return res.json({ appointments: localizeRows(appointments, tz, APPT_TZ_FIELDS) });
  } catch (err) {
    logger.error("GET /jobs/:id/appointments failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load appointments" });
  }
});

router.post("/:id/appointments", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { scheduled_start } = req.body;
    if (!scheduled_start)
      return res.status(400).json({ error: "scheduled_start is required" });

    const jobId = Number(req.params.id);
    const tz = await getCompanyTimezone(companyId);
    // scheduled_start/scheduled_end arrive as naive wall-clock strings meant in
    // the company's timezone (matching the Retell create_appointment tool contract).
    const fields = {
      ...req.body,
      scheduled_start: localToUTC(scheduled_start, tz),
      ...(req.body.scheduled_end ? { scheduled_end: localToUTC(req.body.scheduled_end, tz) } : {}),
    };
    const appointment = await jobsDb.createAppointment(companyId, jobId, fields);

    // An appointment can't exist without being tied to a scheduled job.
    // Promote job status open → scheduled only. Never demote a completed job.
    const db = require("../db");
    await db.query(
      `UPDATE jobs SET status = 'scheduled', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status = 'open'`,
      [jobId, companyId]
    );
    // The new appointment is unconfirmed, so a job sitting at 'confirmed' must
    // drop back to 'scheduled' — otherwise the confirmation sweep skips the job
    // and this appointment never gets confirmed with the customer.
    await syncJobConfirmationStatus(companyId, jobId);

    return res.status(201).json({ appointment: localizeAppointment(appointment, tz) });
  } catch (err) {
    logger.error("POST /jobs/:id/appointments failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create appointment" });
  }
});

// ── Appointments (standalone — for updates) ───────────────────────────────────

router.get("/appointments/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const appointment = await jobsDb.getAppointmentById(
      Number(req.params.id), companyId
    );
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });

    const tz = await getCompanyTimezone(companyId);
    return res.json({ appointment: localizeAppointment(appointment, tz) });
  } catch (err) {
    logger.error("GET /jobs/appointments/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load appointment" });
  }
});

router.patch("/appointments/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    if (Object.keys(req.body).length === 0)
      return res.status(400).json({ error: "No fields to update" });

    // Fetch current appointment to run pre-update checks
    const current = await jobsDb.getAppointmentById(Number(req.params.id), companyId);
    if (!current) return res.status(404).json({ error: "Appointment not found" });

    // A technician must be assigned before their confirmation can be recorded.
    // Check both the existing assignment and any new one being set in this request.
    const technicianId = req.body.technician_id ?? current.technician_id;
    if (req.body.technician_confirmed === true && !technicianId) {
      return res.status(422).json({
        error: "Cannot confirm technician — no technician is assigned to this appointment. Assign a technician first.",
      });
    }

    // scheduled_start/scheduled_end/rescheduled_to, if provided, are naive
    // wall-clock strings meant in the company's timezone (same contract as
    // POST /:id/appointments and the Retell reschedule_appointment tool).
    const tz = await getCompanyTimezone(companyId);
    const updateFields = { ...req.body };
    for (const f of ["scheduled_start", "scheduled_end", "rescheduled_to"]) {
      if (updateFields[f]) updateFields[f] = localToUTC(updateFields[f], tz);
    }

    const appointment = await jobsDb.updateAppointment(
      Number(req.params.id), companyId, updateFields
    );
    if (!appointment) return res.status(404).json({ error: "Appointment not found" });

    // ── Sync job status based on appointment outcome ──────────────────────────
    const effectiveStatus = req.body.status ?? current.status;
    const db = require("../db");

    if (effectiveStatus === "cancelled") {
      // Appointment cancelled — if no other active appointments, revert job to open.
      // Checked before the confirmation recompute because 'open' outranks it:
      // syncJobConfirmationStatus deliberately won't move a job out of 'open'.
      const { rows } = await db.query(
        `SELECT COUNT(*) AS cnt FROM appointments
         WHERE job_id = $1 AND status NOT IN ('cancelled','rescheduled')
           AND id != $2`,
        [current.job_id, current.id]
      );
      if (Number(rows[0].cnt) === 0) {
        await db.query(
          `UPDATE jobs SET status = 'open', updated_at = NOW()
           WHERE id = $1 AND company_id = $2 AND status IN ('scheduled','confirmed')`,
          [current.job_id, companyId]
        );
      }
    }

    // Recompute from the whole upcoming set rather than reacting to this one
    // appointment: the job is 'confirmed' only when EVERY upcoming appointment
    // is, and drops back to 'scheduled' otherwise. This replaces the old
    // flip-on-first-confirmation and the separate rescheduled→scheduled branch,
    // both of which only looked at the appointment in front of them.
    await syncJobConfirmationStatus(companyId, current.job_id);

    return res.json({ appointment: localizeAppointment(appointment, tz) });
  } catch (err) {
    logger.error("PATCH /jobs/appointments/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update appointment" });
  }
});

module.exports = router;
