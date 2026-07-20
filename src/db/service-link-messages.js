/**
 * service_link_messages — tracks the lifecycle of each ServiceTrade Service Link
 * email we attempt to send after a confirmed customer_confirmation call.
 *
 * Flow:
 *   during the call  → setRecipient(...)  writes/updates a `pending` row with the
 *                      resolved contact + confirmed email.
 *   after the call   → markSent / markFailed / markSkipped.
 * Anything not `sent` is surfaced on the platform (list API + a SERVICE_LINK todo).
 *
 * See migrations/062_service_link.sql.
 */

const db = require("./index");

/**
 * Create or update the pending row for a call. One service link per call, so we
 * key on retell_call_id: update the existing row if present, else insert.
 */
async function setRecipient({ companyId, scheduledCallId = null, retellCallId, jobExternalRef = null, contactId = null, email = null }) {
  const existing = await db.query(
    `SELECT id FROM service_link_messages WHERE retell_call_id = $1 AND company_id = $2 ORDER BY id DESC LIMIT 1`,
    [retellCallId, companyId]
  );
  if (existing.rows[0]) {
    const { rows } = await db.query(
      `UPDATE service_link_messages
          SET scheduled_call_id = COALESCE($2, scheduled_call_id),
              job_external_ref  = COALESCE($3, job_external_ref),
              contact_id        = COALESCE($4, contact_id),
              email             = COALESCE($5, email),
              status            = 'pending',
              error             = NULL,
              updated_at        = now()
        WHERE id = $1
      RETURNING *`,
      [existing.rows[0].id, scheduledCallId, jobExternalRef, contactId, email]
    );
    return rows[0];
  }
  const { rows } = await db.query(
    `INSERT INTO service_link_messages
       (company_id, scheduled_call_id, retell_call_id, job_external_ref, contact_id, email, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING *`,
    [companyId, scheduledCallId, retellCallId, jobExternalRef, contactId, email]
  );
  return rows[0];
}

async function getByRetellCallId(companyId, retellCallId) {
  const { rows } = await db.query(
    `SELECT * FROM service_link_messages WHERE retell_call_id = $1 AND company_id = $2 ORDER BY id DESC LIMIT 1`,
    [retellCallId, companyId]
  );
  return rows[0] || null;
}

async function markSent(id, servicetradeMessageId) {
  await db.query(
    `UPDATE service_link_messages SET status='sent', servicetrade_message_id=$2, error=NULL, updated_at=now() WHERE id=$1`,
    [id, servicetradeMessageId != null ? String(servicetradeMessageId) : null]
  );
}

async function markFailed(id, error) {
  await db.query(
    `UPDATE service_link_messages SET status='failed', error=$2, updated_at=now() WHERE id=$1`,
    [id, error ? String(error).slice(0, 2000) : null]
  );
}

/** Record that we intended to send but had nothing to send to (no contact/email). */
async function markSkipped({ companyId, scheduledCallId = null, retellCallId, jobExternalRef = null, reason = null }) {
  const existing = await getByRetellCallId(companyId, retellCallId);
  if (existing) {
    await db.query(
      `UPDATE service_link_messages SET status='skipped', error=$2, updated_at=now() WHERE id=$1`,
      [existing.id, reason]
    );
    return existing.id;
  }
  const { rows } = await db.query(
    `INSERT INTO service_link_messages
       (company_id, scheduled_call_id, retell_call_id, job_external_ref, status, error)
     VALUES ($1, $2, $3, $4, 'skipped', $5)
     RETURNING id`,
    [companyId, scheduledCallId, retellCallId, jobExternalRef, reason]
  );
  return rows[0].id;
}

async function listByCompany(companyId, { status = null, limit = 50, offset = 0 } = {}) {
  const params = [companyId];
  let where = `company_id = $1`;
  if (status) { params.push(status); where += ` AND status = $${params.length}`; }
  params.push(limit, offset);
  const { rows } = await db.query(
    `SELECT * FROM service_link_messages WHERE ${where}
     ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

module.exports = { setRecipient, getByRetellCallId, markSent, markFailed, markSkipped, listByCompany };
