ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('open','scheduled','rescheduled','confirmed','in_progress','completed','cancelled'));
