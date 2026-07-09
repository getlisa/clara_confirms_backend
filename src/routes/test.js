/**
 * POST /test/call
 * Immediately places an outbound call via Retell (no scheduler, no wait).
 * Marked is_test=true so it stays separate from production calls and todos.
 *
 * Body: { phone_number, call_type, customer_name?, job_date? }
 */
const express = require("express");
const { createCall } = require("../services/retell");
const { authenticate, getCompanyId } = require("../auth");
const db = require("../db");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

router.post("/call", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { phone_number, call_type, customer_name, job_date } = req.body;

    if (!phone_number) return res.status(400).json({ error: "phone_number is required" });
    if (!call_type)    return res.status(400).json({ error: "call_type is required" });

    // Verify the campaign key exists for this company (call_type carries the campaign key)
    const { rows } = await db.query(
      `SELECT name FROM campaigns WHERE company_id = $1 AND trigger_type = $2 LIMIT 1`,
      [companyId, call_type]
    );
    if (rows.length === 0)
      return res.status(400).json({ error: `campaign '${call_type}' not found for this company` });

    const dynamicVariables = {
      ...(customer_name && { customer_name }),
      ...(job_date && {
        job_date: new Date(job_date).toLocaleDateString("en-US", {
          weekday: "long", year: "numeric", month: "long", day: "numeric",
        }),
      }),
    };

    const call = await createCall({
      toNumber:         phone_number,
      companyId:        Number(companyId),
      callType:         call_type,
      dynamicVariables,
      metadata:         { is_test: true },
    });

    logger.info("Test call placed", { companyId, callType: call_type, phone: phone_number, callId: call.call_id });

    return res.json({
      call_id:    call.call_id,
      status:     call.call_status,
      agent_id:   call.agent_id,
      message:    "Call initiated. Results will appear in the Calls page (enable 'Test calls' toggle).",
    });
  } catch (err) {
    logger.error("POST /test/call failed", { error: err.message });
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
