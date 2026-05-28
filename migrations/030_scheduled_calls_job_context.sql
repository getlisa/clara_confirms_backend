-- Add job context columns to scheduled_calls so the dispatcher can pass them to Retell
ALTER TABLE scheduled_calls
  ADD COLUMN IF NOT EXISTS job_name        TEXT,
  ADD COLUMN IF NOT EXISTS job_description TEXT,
  ADD COLUMN IF NOT EXISTS job_type        TEXT;
