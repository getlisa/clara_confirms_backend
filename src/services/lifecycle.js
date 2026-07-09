/**
 * Job / Appointment lifecycle transitions (Process 2 — Delivery).
 *
 * The single source of truth for how a Job's status follows its appointments.
 * Hard time lives on appointments; a Job's status reflects the state of its
 * appointments. This centralizes the status-sync that previously lived inline in
 * src/routes/jobs.js.
 *
 * Auto-managed job statuses: open ⇆ scheduled ⇆ confirmed. The manual/terminal
 * statuses (in_progress, completed, cancelled, rescheduled) are never changed
 * here — an operator sets those explicitly.
 *
 * Appointment state machine (owned by db/jobs.updateAppointment):
 *   scheduled → confirmed → completed | rescheduled | cancelled | no_show
 * A time change auto-promotes an appointment to `rescheduled` and flags
 * reschedule_requested; confirmation flags auto-stamp *_confirmed_at.
 */

const db = require("../db");

// An appointment was created → a job that was still `open` now has a visit on
// the calendar. Never demotes a confirmed/completed job.
async function onAppointmentCreated(companyId, jobId) {
  await db.query(
    `UPDATE jobs SET status = 'scheduled', updated_at = NOW()
      WHERE id = $1 AND company_id = $2 AND status = 'open'`,
    [jobId, companyId]
  );
}

// An appointment was updated → reconcile the parent job's status with the
// outcome. `current` is the appointment row BEFORE the update; `patch` is the
// set of fields the caller sent.
async function onAppointmentUpdated(companyId, { current, patch }) {
  const effectiveCustomerConfirmed = patch.customer_confirmed ?? current.customer_confirmed;
  const effectiveStatus            = patch.status            ?? current.status;

  if (effectiveStatus === "rescheduled") {
    // Customer asked to reschedule — a confirmed job needs re-confirmation.
    await db.query(
      `UPDATE jobs SET status = 'scheduled', updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND status = 'confirmed'`,
      [current.job_id, companyId]
    );
  } else if (effectiveCustomerConfirmed === true) {
    // Customer confirmed — promote a scheduled job to confirmed.
    await db.query(
      `UPDATE jobs SET status = 'confirmed', updated_at = NOW()
        WHERE id = $1 AND company_id = $2 AND status = 'scheduled'`,
      [current.job_id, companyId]
    );
  } else if (effectiveStatus === "cancelled") {
    // Appointment cancelled — if no other active appointment remains, reopen the job.
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM appointments
        WHERE job_id = $1 AND status NOT IN ('cancelled','rescheduled') AND id != $2`,
      [current.job_id, current.id]
    );
    if (Number(rows[0].cnt) === 0) {
      await db.query(
        `UPDATE jobs SET status = 'open', updated_at = NOW()
          WHERE id = $1 AND company_id = $2 AND status IN ('scheduled','confirmed')`,
        [current.job_id, companyId]
      );
    }
  }
}

module.exports = { onAppointmentCreated, onAppointmentUpdated };
