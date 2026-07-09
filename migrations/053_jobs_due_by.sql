-- ─────────────────────────────────────────────────────────────────────────────
-- Time-ownership fix — EXPAND phase (Process 2 / Delivery).
--
-- Only appointments own HARD time (scheduled_start/end). Jobs stop owning time:
--   • due_by                 — SOFT booking/completion deadline (drives outreach)
--   • earliest_appointment_at — DERIVED convenience cache of the job's next visit
--
-- This migration is additive + backfill-only. The old job time columns
-- (scheduled_date, scheduled_window_start/end) are dropped later in 054, AFTER
-- the application code has been cut over to the new columns.
--
-- Idempotent: safe to re-run (the migration runner re-applies every file).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS due_by DATE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS earliest_appointment_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS jobs_due_by_idx ON jobs (company_id, due_by);

-- Backfill the soft deadline from the column being retired.
UPDATE jobs
   SET due_by = scheduled_date
 WHERE due_by IS NULL
   AND scheduled_date IS NOT NULL;

-- Preserve HARD time: for jobs that carried a window but have NO appointment yet,
-- synthesize one so the visit time is not lost when the job columns are dropped.
-- The NOT EXISTS guard makes this re-runnable (no duplicate backfill appointments).
INSERT INTO appointments
       (company_id, job_id, technician_id, scheduled_start, scheduled_end, status, source)
SELECT j.company_id, j.id, j.technician_id,
       j.scheduled_window_start,
       j.scheduled_window_end,
       CASE WHEN j.status IN ('confirmed','completed','cancelled') THEN j.status
            ELSE 'scheduled' END,
       'backfill'
  FROM jobs j
 WHERE j.scheduled_window_start IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.job_id = j.id);

-- Seed the derived cache from each job's earliest active appointment.
UPDATE jobs j
   SET earliest_appointment_at = sub.min_start
  FROM (
    SELECT job_id, MIN(scheduled_start) AS min_start
      FROM appointments
     WHERE status NOT IN ('cancelled','rescheduled')
     GROUP BY job_id
  ) sub
 WHERE sub.job_id = j.id;
