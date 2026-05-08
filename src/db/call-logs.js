const db = require("./index");

async function insert({ companyId, callId, retellCallId, eventType, payload }) {
  await db.query(
    `INSERT INTO call_logs (company_id, call_id, retell_call_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [companyId, callId || null, retellCallId, eventType, payload ? JSON.stringify(payload) : null]
  );
}

async function listByCompany(companyId, { limit = 50, offset = 0 } = {}) {
  const result = await db.query(
    `SELECT cl.*, c.to_number, c.appointment_confirmed, c.user_sentiment
     FROM call_logs cl
     LEFT JOIN calls c ON c.id = cl.call_id
     WHERE cl.company_id = $1
     ORDER BY cl.created_at DESC
     LIMIT $2 OFFSET $3`,
    [companyId, limit, offset]
  );
  return result.rows;
}

async function listByCall(callId, companyId) {
  const result = await db.query(
    `SELECT * FROM call_logs
     WHERE call_id = $1 AND company_id = $2
     ORDER BY created_at ASC`,
    [callId, companyId]
  );
  return result.rows;
}

module.exports = { insert, listByCompany, listByCall };
