/**
 * audit_log (migration 115) — who did what on a shared company account.
 *
 * Never throws: an audit write failing must not fail the action it records.
 */

const db = require("./index");
const logger = require("../utils/logger");

async function record({ companyId, actorUserId = null, action, targetType = null, targetId = null, metadata = {} }) {
  try {
    await db.query(
      `INSERT INTO audit_log (company_id, actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [companyId, actorUserId, action, targetType, targetId != null ? String(targetId) : null, JSON.stringify(metadata || {})]
    );
  } catch (err) {
    logger.warn("audit_log write failed", { companyId, action, error: err.message });
  }
}

async function list(companyId, { limit = 50, offset = 0 } = {}) {
  const { rows } = await db.query(
    `SELECT a.id, a.action, a.target_type, a.target_id, a.metadata, a.created_at, a.actor_user_id,
            NULLIF(btrim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), '') AS actor_name,
            u.email AS actor_email
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE a.company_id = $1
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $2 OFFSET $3`,
    [companyId, Math.min(Math.max(Number(limit) || 50, 1), 200), Math.max(Number(offset) || 0, 0)]
  );
  return rows;
}

module.exports = { record, list };
