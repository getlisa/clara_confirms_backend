-- Per-row escape hatch from the dispatcher's business-hours filter.
-- Set true on rows that must dial regardless of the tenant's office hours —
-- primarily POST /calls/manual with immediate=true (the Service Manager
-- explicitly clicked Call Now). Cron-scheduled rows always default to false.

ALTER TABLE scheduled_calls
  ADD COLUMN IF NOT EXISTS bypass_office_hours BOOLEAN NOT NULL DEFAULT false;
