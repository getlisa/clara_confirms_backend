-- Per-company toggles for the system cron behavior.
-- Manual UI triggers always work regardless of these flags.
ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS auto_schedule_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS auto_dispatch_enabled BOOLEAN NOT NULL DEFAULT true;
