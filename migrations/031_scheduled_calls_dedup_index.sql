-- Prevent duplicate active scheduled calls for the same job + call type (race-safe).
CREATE UNIQUE INDEX IF NOT EXISTS scheduled_calls_active_uniq
  ON scheduled_calls (company_id, job_id, call_type)
  WHERE status IN ('pending', 'in_progress');
