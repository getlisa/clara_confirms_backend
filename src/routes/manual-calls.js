/**
 * POST /calls/manual — fire a confirmation call for a single target.
 *
 * Body:
 *   {
 *     trigger_type:    "scheduled_unconfirmed" | "technician_unconfirmed" | "open_job_due_soon" | "quotation_pending",
 *     appointment_id?: number,  // for scheduled_unconfirmed / technician_unconfirmed
 *     job_id?:         string|number,  // for open_job_due_soon
 *     quotation_id?:   number,  // for quotation_pending
 *     immediate?:      boolean (default true),
 *     force?:          boolean (default false),
 *     scheduled_at?:   string (ISO; ignored when immediate=true)
 *   }
 *
 * The actual `call_type` written to scheduled_calls (e.g. "customer_confirmation")
 * comes from the company's `call_trigger_configs` row for the given trigger_type.
 */

const express = require("express");
const { authenticate, getCompanyId } = require("../auth");
const manualCall = require("../services/manual-call");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

router.post("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const result = await manualCall.triggerManualCall({
      companyId,
      triggerType:   req.body?.trigger_type || req.body?.call_type, // accept either; FE should send trigger_type
      appointmentId: req.body?.appointment_id != null ? Number(req.body.appointment_id) : undefined,
      jobId:         req.body?.job_id != null ? String(req.body.job_id) : undefined,
      quotationId:   req.body?.quotation_id != null ? Number(req.body.quotation_id) : undefined,
      immediate:     req.body?.immediate !== false,         // default true
      force:         req.body?.force === true,              // default false
      scheduledAt:   req.body?.scheduled_at || null,
    });

    return res.status(result.status || (result.ok ? 201 : 400)).json(result);
  } catch (err) {
    logger.error("POST /calls/manual failed", { error: err.message, stack: err.stack });
    return res.status(500).json({ error: "Failed to trigger manual call" });
  }
});

module.exports = router;
