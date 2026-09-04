-- Add 'pending' to jobs.status.
--
-- InspectPoint's dominant status is `pending` — 1,555 of a real tenant's 1,566
-- open inspections — and it was being flattened into our generic `open`. That
-- lost a real distinction: on InspectPoint, "Pending" is what the customer and
-- the technician both see, so a job shown as "Open" in our UI doesn't match
-- what the CRM says. `open` remains the vocabulary for every other source.
--
-- ⚠ 'pending' is a LABEL, not a new behaviour. It is semantically identical to
-- 'open' — "exists, nothing scheduled yet" — and every query that matches
-- 'open' must also match 'pending'. See UNSCHEDULED_JOB_STATUSES in
-- src/db/jobs.js, which is the single definition both sides share; the
-- alternative (treating 'pending' as non-actionable) would have silently
-- switched off the open_job_due_soon outreach sweep for the entire
-- InspectPoint tenant.
--
-- Additive only: no existing row changes status here. InspectPoint jobs move
-- to 'pending' on their next normalize pass, since JOB_STATUS_MAP is re-applied
-- to every row on every sync.

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;

ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN (
    'open',
    'pending',
    'scheduled',
    'rescheduled',
    'confirmed',
    'in_progress',
    'completed',
    'cancelled'
  ));
