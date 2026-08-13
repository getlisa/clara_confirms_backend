/**
 * POST /calls/manual — fire a confirmation call for a single target.
 *
 * Body:
 *   {
 *     trigger_type:    "scheduled_unconfirmed" | "technician_unconfirmed" | "open_job_due_soon" | "quotation_pending",
 *     appointment_id?: number,  // for scheduled_unconfirmed / technician_unconfirmed
 *     job_id?:         string|number,  // for open_job_due_soon
 *     quotation_id?:   number,  // for quotation_pending
 *     phone_number?:   string,  // optional manual override; for channel "voice"/"sms" dials this number (normalized
 *                      to E.164) instead of the target's on-file number; for channel "web_chat" it's an alternate
 *                      to email — texts the chat-link confirmation to this number instead (when
 *                      chat_link_delivery_method is "sms"/"both")
 *     email?:          string,  // optional manual override; emails this address instead of the customer's on-file email (channel: "web_chat" only)
 *     immediate?:      boolean (default true),
 *     force?:          boolean (default false),
 *     scheduled_at?:   string (ISO; ignored when immediate=true)
 *     channel?:        "voice" | "sms" | "web_chat" — explicit override for the
 *                      Call Now / Text Now / Email Now buttons. "web_chat" sends a chat-link
 *                      confirmation by email/SMS/both (per the company's chat_link_delivery_method)
 *                      instead of dialing — the "sms" leg is a plain text with the link (via Twilio,
 *                      NOT the conversational createSmsChat mechanism "sms"/Text Now uses) — requires
 *                      the matching contact info on file or as an override (422 "missing_email" |
 *                      "missing_phone" | "missing_contact_info" if not).
 *   }
 *
 * The actual `call_type` written to scheduled_calls (e.g. "customer_confirmation")
 * comes from the company's `call_trigger_configs` row for the given trigger_type.
 */

const express = require("express");
const { authenticate, getCompanyId } = require("../auth");
const manualCall = require("../services/manual-call");
const logger = require("../utils/logger");
const { getCompanyTimezone, localizeFields } = require("../utils/timezone");

const router = express.Router();
router.use(authenticate);

// job_date is a DATE-only column — never passed through this.
const SCHEDULED_CALL_TZ_FIELDS = ["scheduled_at", "last_attempted_at", "created_at", "updated_at", "callback_requested_at"];

router.post("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const result = await manualCall.triggerManualCall({
      triggeredByUserId: req.user?.userId ?? null,
      companyId,
      triggerType:   req.body?.trigger_type || req.body?.call_type, // accept either; FE should send trigger_type
      appointmentId: req.body?.appointment_id != null ? Number(req.body.appointment_id) : undefined,
      jobId:         req.body?.job_id != null ? String(req.body.job_id) : undefined,
      quotationId:   req.body?.quotation_id != null ? Number(req.body.quotation_id) : undefined,
      phoneNumber:   req.body?.phone_number != null ? String(req.body.phone_number) : undefined,
      email:         req.body?.email != null ? String(req.body.email) : undefined,
      immediate:     req.body?.immediate !== false,         // default true
      force:         req.body?.force === true,              // default false
      channel:       ["voice", "sms", "web_chat"].includes(req.body?.channel) ? req.body.channel : null, // "Call Now" / "Text Now" / "Email Now"
      scheduledAt:   req.body?.scheduled_at || null,
    });

    if (result.scheduledCall) {
      const tz = await getCompanyTimezone(companyId);
      result.scheduledCall = localizeFields(result.scheduledCall, tz, SCHEDULED_CALL_TZ_FIELDS);
    }
    return res.status(result.status || (result.ok ? 201 : 400)).json(result);
  } catch (err) {
    logger.error("POST /calls/manual failed", { error: err.message, stack: err.stack });
    return res.status(500).json({ error: "Failed to trigger manual call" });
  }
});

module.exports = router;
