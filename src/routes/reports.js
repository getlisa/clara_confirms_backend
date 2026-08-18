/**
 * Daily operations report — recipient management + on-demand actions.
 *
 * GET/POST/PATCH/DELETE /reports/recipients   — authenticated (staff)
 * POST /reports/daily/preview                 — authenticated (staff), no send
 * POST /reports/daily/send-now                — authenticated (staff), SENDS A REAL EMAIL
 *
 * The actual scheduled send lives in the admin sweep (routes/admin.js,
 * services/daily-report/send.js's runSweep) — this file is the surface staff
 * use to configure and test it, not the delivery mechanism itself.
 */

const express = require("express");
const { authenticate, getCompanyId } = require("../auth");
const reportRecipientsDb = require("../db/report-recipients");
const { collectSummary } = require("../services/daily-report/collect");
const { sendForRecipient } = require("../services/daily-report/send");
const { getCompanyTimezone } = require("../utils/timezone");
const db = require("../db");
const logger = require("../utils/logger");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Deliberately restrictive: the sweep runs every 15 minutes, so a time not on
// this grid would fire up to 15 minutes late every single day, every time —
// better to refuse it up front than let it look subtly broken forever.
const TIME_RE = /^([01]\d|2[0-3]):(00|30)$/;

function validateRecipientFields(body, { partial = false } = {}) {
  if (!partial || "email" in body) {
    if (!body.email || !EMAIL_RE.test(String(body.email).trim())) return "A valid email is required";
  }
  if ("send_at_local" in body && body.send_at_local != null) {
    if (!TIME_RE.test(body.send_at_local)) return "send_at_local must be on the hour or half-hour, e.g. '21:00' or '21:30'";
  }
  return null;
}

router.get("/recipients", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const recipients = await reportRecipientsDb.list(companyId);
    return res.json({ recipients });
  } catch (err) {
    logger.error("GET /reports/recipients failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load recipients" });
  }
});

router.post("/recipients", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const err = validateRecipientFields(req.body || {});
    if (err) return res.status(400).json({ error: err });

    const recipient = await reportRecipientsDb.create({
      companyId,
      email: req.body.email,
      name: req.body.name ?? null,
      sendAtLocal: req.body.send_at_local || "21:00",
      // Defaults to false regardless of what the caller sends — a recipient
      // must be explicitly turned on via PATCH after being reviewed, never
      // enabled at creation time (see migrations/096).
      enabled: false,
    });
    return res.status(201).json({ recipient });
  } catch (err) {
    if (err.code === "DUPLICATE") return res.status(409).json({ error: err.message });
    logger.error("POST /reports/recipients failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create recipient" });
  }
});

router.patch("/recipients/:id", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const err = validateRecipientFields(req.body || {}, { partial: true });
    if (err) return res.status(400).json({ error: err });

    const recipient = await reportRecipientsDb.update(companyId, Number(req.params.id), req.body || {});
    if (!recipient) return res.status(404).json({ error: "Recipient not found" });
    return res.json({ recipient });
  } catch (err) {
    if (err.code === "DUPLICATE") return res.status(409).json({ error: err.message });
    logger.error("PATCH /reports/recipients/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update recipient" });
  }
});

router.delete("/recipients/:id", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const removed = await reportRecipientsDb.remove(companyId, Number(req.params.id));
    if (!removed) return res.status(404).json({ error: "Recipient not found" });
    return res.json({ message: "Deleted" });
  } catch (err) {
    logger.error("DELETE /reports/recipients/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to delete recipient" });
  }
});

// POST /reports/daily/preview?date=YYYY-MM-DD — the Summary numbers only, no
// send, no attachment build. Defaults to yesterday if no date is given, since
// "what would today's not-yet-finished business day look like" isn't a
// meaningful preview.
router.post("/daily/preview", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const tz = await getCompanyTimezone(companyId);
    const businessDate = req.body?.date || req.query?.date
      || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    const summary = await collectSummary(companyId, businessDate, tz);
    return res.json({ summary });
  } catch (err) {
    logger.error("POST /reports/daily/preview failed", { error: err.message });
    return res.status(500).json({ error: "Failed to build preview" });
  }
});

// POST /reports/daily/send-now — SENDS A REAL EMAIL to the given recipient,
// immediately, bypassing the schedule/idempotency check entirely (repeatable
// on purpose, for testing). Body: { recipient_id, date? }.
router.post("/daily/send-now", authenticate, async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const recipientId = Number(req.body?.recipient_id);
    if (!recipientId) return res.status(400).json({ error: "recipient_id is required" });

    const recipient = await reportRecipientsDb.getById(companyId, recipientId);
    if (!recipient) return res.status(404).json({ error: "Recipient not found" });

    const tz = await getCompanyTimezone(companyId);
    const businessDate = req.body?.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const { rows } = await db.query(`SELECT name FROM companies WHERE id = $1`, [companyId]);

    const result = await sendForRecipient(
      { ...recipient, company_id: companyId },
      { businessDate, companyName: rows[0]?.name || "Your company", tz, stampSent: false }
    );
    return res.json({ ok: true, sent_to: recipient.email, ...result });
  } catch (err) {
    logger.error("POST /reports/daily/send-now failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send report" });
  }
});

module.exports = router;
