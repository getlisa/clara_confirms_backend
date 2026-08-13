/**
 * GET /logs — unified activity log: calls and chat links as one ordered,
 * paginated list. Replaces the frontend's two-fetch client-side merge, which
 * could not paginate correctly across two independently-paginated sources.
 *
 * There are exactly TWO channels: `call` and `chat`. A `calls` row with
 * channel 'web_chat' or 'sms' is reported as `chat` — a text carrying a
 * chat-link URL is the same conversation as an emailed one, differing only in
 * delivery, and delivery medium is not a channel.
 */

const express = require("express");
const { authenticate, getCompanyId } = require("../auth");
const logsDb = require("../db/logs");
const { getCompanyTimezone, localizeRows } = require("../utils/timezone");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

const CHANNELS = ["call", "chat"];
const CHAT_STATUSES = ["sent", "in_progress", "ended", "expired"];
const TZ_FIELDS = ["timestamp"];

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { channel, status, state, outcome, search, is_test } = req.query;
    if (channel && !CHANNELS.includes(String(channel))) {
      return res.status(400).json({ error: `channel must be one of ${CHANNELS.join(", ")}` });
    }
    if (status && !CHAT_STATUSES.includes(String(status))) {
      return res.status(400).json({ error: `status must be one of ${CHAT_STATUSES.join(", ")}` });
    }

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const { rows, counts, total } = await logsDb.list(companyId, {
      channel: channel ? String(channel) : null,
      status: status ? String(status) : null,
      state: state ? String(state) : null,
      outcome: outcome ? String(outcome) : null,
      search: search ? String(search) : null,
      isTest: is_test === "true",
      limit, offset,
    });

    // Each row keeps its source record nested, so the detail sheet still has
    // everything the single-source endpoints returned.
    const logs = rows.map((r) => ({
      source: r.source,
      id: r.id,
      timestamp: r.timestamp,
      channel: r.channel,
      job_id: r.job_id,
      appointment_id: r.appointment_id,
      job_name: r.job_name,
      job_number: r.job_number,
      customer_name: r.customer_name,
      location_name: r.location_name,
      recipient_name: r.recipient_name,
      recipient_phone: r.recipient_phone,
      recipient_email: r.recipient_email,
      ...(r.source === "call" ? { call: r.record } : { chat_link: r.record }),
    }));

    const tz = await getCompanyTimezone(companyId);
    return res.json({
      logs: localizeRows(logs, tz, TZ_FIELDS),
      counts,
      pagination: { limit, offset, total },
    });
  } catch (err) {
    logger.error("GET /logs failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load logs" });
  }
});

module.exports = router;
