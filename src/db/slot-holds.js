/**
 * Soft slot holds (migrations/105_slot_holds.sql) — the race-prevention layer
 * for reschedule/create slot suggestion (Phase 6). A hold is placed the
 * instant a candidate window is OFFERED to a customer/agent, before they've
 * agreed to it, so two conversations proposing the same technician's
 * calendar at the same moment can't both read out the same slot. See the
 * migration file for why the exclusion constraint is unconditional (no
 * `expires_at` predicate) and expiry is swept here instead.
 *
 * `held_by_token` is whichever conversation/call currently owns the hold — a
 * chat thread token or a Retell call id — so that same conversation's own
 * later reschedule_appointment/create_appointment call can look its hold back
 * up by (technician, exact start time, token) without needing to round-trip
 * an opaque hold id through the LLM.
 */
const db = require("./index");

const EXCLUSION_VIOLATION = "23P01";

function row(r) {
  return {
    id: r.id,
    company_id: r.company_id,
    technician_id: r.technician_id,
    starts_at: r.starts_at,
    ends_at: r.ends_at,
    held_by_token: r.held_by_token,
    appointment_id: r.appointment_id,
    expires_at: r.expires_at,
  };
}

/** A pg error with this code means the GiST exclusion constraint rejected the write — a genuine conflict, not a bug. */
function isSlotConflictError(err) {
  return err?.code === EXCLUSION_VIOLATION;
}

/**
 * Place a hold, sweeping this company's expired holds first in the SAME
 * transaction so a long-dead hold never blocks a legitimate new one. Returns
 * `{ok:false, conflict:true}` — never throws — when the exclusion constraint
 * rejects the insert, so a caller offering several candidate slots can just
 * skip a conflicting one and try the next.
 */
async function hold({ companyId, technicianId, startsAt, endsAt, heldByToken, ttlMinutes = 10 }) {
  try {
    return await db.transaction(async (client) => {
      await client.query(`DELETE FROM slot_holds WHERE company_id = $1 AND expires_at < NOW()`, [companyId]);
      const result = await client.query(
        `INSERT INTO slot_holds (company_id, technician_id, starts_at, ends_at, held_by_token, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval)
         RETURNING *`,
        [companyId, technicianId, startsAt, endsAt, heldByToken, ttlMinutes]
      );
      return { ok: true, hold: row(result.rows[0]) };
    });
  } catch (err) {
    if (isSlotConflictError(err)) return { ok: false, conflict: true };
    throw err;
  }
}

/**
 * Atomically verify-and-consume the hold this exact conversation placed on
 * this exact window, if one still exists and hasn't expired. Returns null
 * (never throws) when there's nothing to consume — a customer can always
 * name a time that was never proposed via propose_reschedule_slots, and that
 * is not an error, just a reschedule with no hold to clean up.
 */
async function consumeByWindow({ companyId, technicianId, startsAt, heldByToken }) {
  const result = await db.query(
    `DELETE FROM slot_holds
     WHERE company_id = $1 AND technician_id = $2 AND starts_at = $3 AND held_by_token = $4
       AND expires_at > NOW()
     RETURNING *`,
    [companyId, technicianId, startsAt, heldByToken]
  );
  return result.rows[0] ? row(result.rows[0]) : null;
}

/** Best-effort cleanup of every OTHER hold this conversation placed, once one of them has been confirmed. */
async function releaseAllForToken({ companyId, heldByToken }) {
  await db.query(`DELETE FROM slot_holds WHERE company_id = $1 AND held_by_token = $2`, [companyId, heldByToken]);
}

async function listActive({ companyId, technicianId, from, to }) {
  const result = await db.query(
    `SELECT * FROM slot_holds
     WHERE company_id = $1 AND technician_id = $2 AND expires_at > NOW()
       AND starts_at < $4 AND ends_at > $3`,
    [companyId, technicianId, from, to]
  );
  return result.rows.map(row);
}

module.exports = { hold, consumeByWindow, releaseAllForToken, listActive, isSlotConflictError };
