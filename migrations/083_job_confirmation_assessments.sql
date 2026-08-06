-- Per-job LLM assessment of whether ServiceTrade's own human-entered
-- comments/notes (scheduling_comments/job_notes/appointment_notes, synced
-- from ServiceTrade — a CSR/tech writing e.g. "called customer, confirmed
-- for Tuesday") already show the customer confirmed. Durable, queryable
-- record of "confirmed or not, and why" — separate from the operational
-- appointments.customer_confirmed flag it sometimes drives (see
-- src/services/job-confirmation-inference.js).
CREATE TABLE job_confirmation_assessments (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  confirmed TEXT NOT NULL CHECK (confirmed IN ('yes', 'no', 'unclear')),
  confidence NUMERIC,
  reasoning TEXT,
  evidence TEXT,
  comment_count INTEGER NOT NULL DEFAULT 0, -- lets sync skip re-running the LLM when nothing new was added
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, job_id)
);

CREATE INDEX job_confirmation_assessments_job_idx ON job_confirmation_assessments (company_id, job_id);

-- Per-company opt-in — off by default, same caution as
-- crm_comment_writeback_enabled (migration 061): an LLM's read of
-- loosely-structured CSR notes could in principle suppress a real
-- confirmation dispatch if wrong, so this stays off until a company
-- explicitly turns it on.
ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS job_confirmation_inference_enabled BOOLEAN NOT NULL DEFAULT false;
