-- ─────────────────────────────────────────────────────────────────────────────
-- Time-ownership fix — CONTRACT phase (Process 2 / Delivery).
--
-- Drops the retired job time columns. Appointments now own all HARD time; jobs
-- carry only due_by (soft deadline) + earliest_appointment_at (derived cache),
-- added in 053.
--
-- ⚠️ Apply ONLY after the application code has been cut over off scheduled_date/
-- scheduled_window_* (migration 053 + the code changes) and verified. Running this
-- before the code cutover will break live `SELECT j.*` queries and the jobs sort.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

DROP INDEX IF EXISTS jobs_scheduled_date_idx;

ALTER TABLE jobs DROP COLUMN IF EXISTS scheduled_date;
ALTER TABLE jobs DROP COLUMN IF EXISTS scheduled_window_start;
ALTER TABLE jobs DROP COLUMN IF EXISTS scheduled_window_end;
