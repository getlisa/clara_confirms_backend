/**
 * Scheduled Calls routes — view the call queue
 *
 * GET /scheduled-calls          list scheduled calls with filters
 * DELETE /scheduled-calls/:id   cancel a pending call
 */

const express = require("express");
const db = require("../db");
const { authenticate, getCompanyId } = require("../auth");
const { isWithinActiveHours, getNextWindowStart } = require("../services/scheduler");
const callSettingsDb = require("../db/call-settings");
const scheduledCallsDb = require("../db/scheduled-calls");
const { CUSTOMER_CALL_TYPES } = scheduledCallsDb;
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

/**
 * GET /scheduled-calls
 * Query params: status, call_type, is_test, limit, offset
 */
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { status, call_type, is_test, limit, offset } = req.query;

    const conditions = ["sc.company_id = $1"];
    const values = [companyId];
    let i = 2;

    if (status)    { conditions.push(`sc.status = $${i++}`);    values.push(status); }
    if (call_type) { conditions.push(`sc.call_type = $${i++}`); values.push(call_type); }
    // is_test defaults to false (show production schedule by default)
    conditions.push(`sc.is_test = $${i++}`);
    values.push(is_test === "true");

    values.push(limit ? Math.min(Number(limit), 200) : 50, offset ? Number(offset) : 0);

    const result = await db.query(
      `SELECT
         sc.id,
         sc.call_type,
         sc.phone_number,
         sc.job_id,
         sc.job_date,
         sc.customer_name,
         sc.technician_name,
         sc.customer_address,
         sc.status,
         sc.scheduled_at,
         sc.is_test,
         sc.attempt_number,
         sc.max_attempts,
         sc.failure_reason,
         sc.retell_call_id,
         sc.created_at,
         sc.updated_at,
         -- Join job title if job_id is a numeric reference
         j.title  AS job_title,
         j.status AS job_status
       FROM scheduled_calls sc
       LEFT JOIN jobs j ON j.id::text = sc.job_id AND j.company_id = sc.company_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY sc.scheduled_at ASC, sc.created_at DESC
       LIMIT $${i++} OFFSET $${i}`,
      values
    );

    return res.json({ scheduled_calls: result.rows });
  } catch (err) {
    logger.error("GET /scheduled-calls failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load scheduled calls" });
  }
});

/**
 * POST /scheduled-calls
 * Manually schedule an outbound call.
 * scheduled_at is snapped to the next office-hours window if outside business hours.
 */
router.post("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const {
      call_type, phone_number, customer_name, technician_name,
      customer_address, job_id, job_date, scheduled_at, max_attempts,
    } = req.body;

    if (!phone_number) return res.status(400).json({ error: "phone_number is required" });
    if (!call_type)    return res.status(400).json({ error: "call_type is required" });

    // Validate the campaign key exists for this company (call_type carries the campaign key)
    const { rows } = await db.query(
      `SELECT 1 FROM campaigns WHERE company_id = $1 AND trigger_type = $2 LIMIT 1`,
      [companyId, call_type]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: `campaign '${call_type}' not found for this company` });
    }

    // Snap scheduled_at to office hours
    const { rows: co } = await db.query(
      `SELECT default_timezone FROM companies WHERE id = $1`, [companyId]
    );
    const tz = co[0]?.default_timezone || "America/New_York";
    const callSettings = await callSettingsDb.getByCompanyId(companyId);

    let fireAt;
    if (!scheduled_at) {
      fireAt = getNextWindowStart(callSettings, tz);
    } else {
      const requested = new Date(scheduled_at);
      fireAt = isWithinActiveHours(callSettings, tz, requested)
        ? requested
        : getNextWindowStart(callSettings, tz, requested);
    }

    if (job_id) {
      const dedupeFn = CUSTOMER_CALL_TYPES.includes(call_type)
        ? scheduledCallsDb.existsForCustomerJob
        : scheduledCallsDb.existsForJob;
      if (await dedupeFn(companyId, String(job_id), call_type, false)) {
        return res.status(409).json({
          error: "A scheduled call already exists for this job and call type",
        });
      }
    }

    const row = await scheduledCallsDb.create({
      companyId,
      callType:        call_type,
      phoneNumber:     phone_number,
      jobId:           job_id   ?? null,
      jobDate:         job_date ? new Date(job_date) : null,
      customerName:    customer_name   ?? null,
      technicianName:  technician_name ?? null,
      customerAddress: customer_address ?? null,
      scheduledAt:     fireAt,
      isTest:          false,
      maxAttempts:     max_attempts ?? 3,
    });

    logger.info("Manual call scheduled", { companyId, callType: call_type, phone: phone_number, scheduledAt: fireAt });

    return res.status(201).json({
      scheduled_call: row,
      scheduled_at:   fireAt.toISOString(),
    });
  } catch (err) {
    logger.error("POST /scheduled-calls failed", { error: err.message });
    return res.status(500).json({ error: "Failed to schedule call" });
  }
});

/**
 * DELETE /scheduled-calls/:id
 * Cancel a pending scheduled call. Only pending/in_progress calls can be cancelled.
 */
router.delete("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const result = await db.query(
      `UPDATE scheduled_calls
       SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND company_id = $2 AND status IN ('pending', 'in_progress')
       RETURNING id`,
      [Number(req.params.id), companyId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Scheduled call not found or already completed/cancelled" });
    }

    return res.json({ message: "Scheduled call cancelled" });
  } catch (err) {
    logger.error("DELETE /scheduled-calls/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to cancel scheduled call" });
  }
});

module.exports = router;
