const crypto = require("crypto");
const db = require("./index");

function generateToken() {
  return crypto.randomBytes(24).toString("hex"); // 48 hex chars — unguessable
}

async function findByAppointment(companyId, appointmentId) {
  const result = await db.query(
    `SELECT * FROM chat_links
     WHERE company_id = $1 AND appointment_id = $2 AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, appointmentId]
  );
  return result.rows[0] || null;
}

async function findByJob(companyId, jobId) {
  const result = await db.query(
    `SELECT * FROM chat_links
     WHERE company_id = $1 AND job_id = $2 AND appointment_id IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY created_at DESC LIMIT 1`,
    [companyId, jobId]
  );
  return result.rows[0] || null;
}

async function create({ companyId, jobId = null, appointmentId = null, callType = "customer_confirmation", expiresAt = null }) {
  // Collision probability with 24 random bytes is negligible, but retry once
  // defensively rather than surface a 500 on the 1-in-2^192 case.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const result = await db.query(
        `INSERT INTO chat_links (company_id, token, job_id, appointment_id, call_type, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [companyId, generateToken(), jobId, appointmentId, callType, expiresAt]
      );
      return result.rows[0];
    } catch (err) {
      if (err.code === "23505" && attempt < 2) continue; // unique violation on token — retry
      throw err;
    }
  }
}

async function getByToken(token) {
  const result = await db.query(`SELECT * FROM chat_links WHERE token = $1`, [token]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null;
  return row;
}

async function markOpened(id) {
  await db.query(`UPDATE chat_links SET last_opened_at = NOW() WHERE id = $1`, [id]);
}

module.exports = { findByAppointment, findByJob, create, getByToken, markOpened };
