const db = require("./index");
const logger = require("../utils/logger");

/**
 * All active instructions for a company — general and every service line,
 * unfiltered. Best-effort, same as resolveConfirmedBy/loadServiceLinkForCard
 * elsewhere in this feature: this is enrichment content on top of the
 * appointment/greeting itself, never something that should be able to break
 * opening a chat link outright — a failure here (e.g. migrations/101 not
 * yet applied on a given DB target) degrades to "no instructions," not a
 * 500 on every single chat-link open.
 */
async function listByCompany(companyId) {
  try {
    const { rows } = await db.query(
      `SELECT service_line, instruction, requires_response
         FROM onsite_instructions
        WHERE company_id = $1 AND active
        ORDER BY id`,
      [companyId]
    );
    return rows;
  } catch (err) {
    logger.warn("onsite-instructions: listByCompany failed — degrading to no instructions", { companyId, error: err.message });
    return [];
  }
}

module.exports = { listByCompany };
