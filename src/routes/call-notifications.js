/**
 * Per-conversation notification emails — the settings surface.
 *
 * GET/PATCH  /call-notifications              — the master switch + the whole card
 * POST/PATCH/DELETE /call-notifications/recipients[/:id]
 * POST       /call-notifications/test         — SENDS A REAL EMAIL
 *
 * The scheduled delivery itself lives in the admin drain sweep
 * (routes/admin.js → services/call-notification/drain.js); this file is only
 * what staff use to configure and test it.
 *
 * Note on the master switch: `call_notification_enabled` lives on the
 * call_settings table, so GET /call-settings also RETURNS it. But it is
 * writable only here — PATCH /call-settings whitelists its fields by explicit
 * destructuring, and leaving this one out keeps a single write path for what is
 * a live mailing list.
 */

const express = require("express");
const { authenticate, getCompanyId } = require("../auth");
const callSettingsDb = require("../db/call-settings");
const recipientsDb = require("../db/call-notification-recipients");
const sendsDb = require("../db/call-notification-sends");
const { sendTestNow } = require("../services/call-notification/drain");
const db = require("../db");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

// Same expression routes/reports.js uses, for consistent rejection messages.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function requireCompany(req, res) {
  const companyId = getCompanyId(req);
  if (!companyId) {
    res.status(403).json({ error: "Company context required" });
    return null;
  }
  return companyId;
}

/**
 * GET /call-notifications
 *
 * One request loads the entire settings card, `available_events` included, so
 * the UI renders its scenario checkboxes from the backend's vocabulary instead
 * of a hardcoded list that drifts when a new event key is added.
 */
router.get("/", async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) return;

    const [settings, recipients] = await Promise.all([
      callSettingsDb.getByCompanyId(companyId),
      recipientsDb.list(companyId),
    ]);

    return res.json({
      settings: { enabled: settings.call_notification_enabled === true },
      recipients,
      available_events: recipientsDb.EVENTS,
    });
  } catch (err) {
    logger.error("GET /call-notifications failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load notification settings" });
  }
});

/** PATCH /call-notifications — `{ enabled: boolean }`. */
router.patch("/", async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) return;

    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    const settings = await callSettingsDb.upsert(companyId, { call_notification_enabled: enabled });
    return res.json({ settings: { enabled: settings.call_notification_enabled === true } });
  } catch (err) {
    logger.error("PATCH /call-notifications failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update notification settings" });
  }
});

router.get("/recipients", async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) return;
    return res.json({ recipients: await recipientsDb.list(companyId) });
  } catch (err) {
    logger.error("GET /call-notifications/recipients failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load recipients" });
  }
});

/**
 * POST /call-notifications/recipients
 *
 * `enabled` is NOT accepted: every recipient is created disabled and turned on
 * by a separate PATCH once reviewed, so a half-filled form cannot start
 * emailing a real inbox. Same rule as /reports/recipients.
 */
router.post("/recipients", async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) return;

    const { email, name, events } = req.body || {};
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: "A valid email is required" });
    }

    const recipient = await recipientsDb.create({
      companyId, email, name: name ?? null,
      events: events === undefined ? null : events,
    });
    return res.status(201).json({ recipient });
  } catch (err) {
    if (err.code === "DUPLICATE") return res.status(409).json({ error: err.message });
    if (err.code === "BAD_EVENTS") return res.status(400).json({ error: err.message });
    logger.error("POST /call-notifications/recipients failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create recipient" });
  }
});

/** PATCH /call-notifications/recipients/:id — any subset of email/name/events/enabled. */
router.patch("/recipients/:id", async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) return;

    const body = req.body || {};
    if ("email" in body && (!body.email || !EMAIL_RE.test(String(body.email).trim()))) {
      return res.status(400).json({ error: "A valid email is required" });
    }
    if ("enabled" in body && typeof body.enabled !== "boolean") {
      return res.status(400).json({ error: "enabled must be a boolean" });
    }

    const fields = {};
    for (const key of ["email", "name", "events", "enabled"]) {
      if (key in body) fields[key] = body[key];
    }

    const recipient = await recipientsDb.update(companyId, Number(req.params.id), fields);
    if (!recipient) return res.status(404).json({ error: "Recipient not found" });
    return res.json({ recipient });
  } catch (err) {
    if (err.code === "DUPLICATE") return res.status(409).json({ error: err.message });
    if (err.code === "BAD_EVENTS") return res.status(400).json({ error: err.message });
    logger.error("PATCH /call-notifications/recipients/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update recipient" });
  }
});

router.delete("/recipients/:id", async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) return;
    const removed = await recipientsDb.remove(companyId, Number(req.params.id));
    if (!removed) return res.status(404).json({ error: "Recipient not found" });
    return res.json({ message: "Deleted" });
  } catch (err) {
    logger.error("DELETE /call-notifications/recipients/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to delete recipient" });
  }
});

/**
 * POST /call-notifications/test — ⚠️ SENDS A REAL EMAIL.
 *
 * Body: { recipient_id, call_id? }. Uses the company's most recent analyzed
 * call when call_id is omitted. Synchronous rather than queued so the response
 * can report what actually happened — including whether the audio attached,
 * which is the whole thing being tested. Bypasses the event filter and the
 * dedup index, so it is repeatable and never consumes a real notification.
 */
router.post("/test", async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) return;

    const recipientId = Number(req.body?.recipient_id);
    if (!recipientId) return res.status(400).json({ error: "recipient_id is required" });

    const recipient = await recipientsDb.getById(companyId, recipientId);
    if (!recipient) return res.status(404).json({ error: "Recipient not found" });

    let callId = req.body?.call_id ? Number(req.body.call_id) : null;
    if (!callId) {
      // Prefer a voice call: a chat has no recording, which would make the test
      // silent about the very thing it exists to prove.
      const { rows } = await db.query(
        `SELECT id FROM calls
          WHERE company_id = $1 AND status = 'analyzed'
          ORDER BY (channel = 'voice') DESC, (recording_url IS NOT NULL) DESC, created_at DESC
          LIMIT 1`,
        [companyId]
      );
      callId = rows[0]?.id ?? null;
    }
    if (!callId) {
      return res.status(422).json({
        error: "No analyzed call to send yet. Place a call first, or pass a call_id.",
      });
    }

    const result = await sendTestNow({
      companyId, callId, toEmail: recipient.email, recipientName: recipient.name,
      event: recipient.events?.[0] || "confirmed",
    });
    return res.json({ ok: true, ...result });
  } catch (err) {
    if (err.code === "NOT_FOUND") return res.status(404).json({ error: "Call not found" });
    logger.error("POST /call-notifications/test failed", { error: err.message });
    return res.status(500).json({ error: "Failed to send test notification" });
  }
});

/** GET /call-notifications/history/:retellCallId — what went out for one conversation. */
router.get("/history/:retellCallId", async (req, res) => {
  try {
    const companyId = requireCompany(req, res);
    if (!companyId) return;
    const sends = await sendsDb.listForCall(companyId, String(req.params.retellCallId));
    return res.json({ sends });
  } catch (err) {
    logger.error("GET /call-notifications/history/:retellCallId failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load notification history" });
  }
});

module.exports = router;
