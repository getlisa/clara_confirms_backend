/**
 * GET /service-link-messages — list service-link email attempts for the company,
 * so the UI can surface anything that did not send (status != 'sent').
 *
 * Query params: status (pending|sent|failed|skipped), limit, offset.
 */
const express = require("express");
const serviceLinkMessagesDb = require("../db/service-link-messages");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");
const { getCompanyTimezone, localizeRows } = require("../utils/timezone");

const router = express.Router();
router.use(authenticate);

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });
    const { status, limit, offset } = req.query;
    const rows = await serviceLinkMessagesDb.listByCompany(companyId, {
      status: status || null,
      limit: limit ? Math.min(Number(limit), 200) : 50,
      offset: offset ? Number(offset) : 0,
    });
    const tz = await getCompanyTimezone(companyId);
    return res.json({ service_link_messages: localizeRows(rows, tz, ["created_at", "updated_at"]) });
  } catch (err) {
    logger.error("GET /service-link-messages failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load service link messages" });
  }
});

module.exports = router;
