-- How Clara tells the customer when the technician arrives (call_settings).
--
--   window                   (default — today's behaviour) "between 11 AM and 12 PM":
--                            scheduled − before → scheduled + after (default 0 / 60).
--   scheduled_with_tolerance "Your appointment is scheduled for 11 AM. Please note
--                            that our technicians may arrive up to 30 minutes before
--                            or after your scheduled appointment time."
--   scheduled_only           "Your appointment is scheduled for 11 AM."
--
-- The sentence is precomputed per visit in job-confirmation-context and handed
-- to both agents verbatim (voice: {{next_arrival_statement}}; chat: the prompt's
-- ARRIVAL TIME section), so no model ever does the clock arithmetic.

ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS arrival_time_style VARCHAR(32) NOT NULL DEFAULT 'window',
  ADD COLUMN IF NOT EXISTS arrival_minutes_before INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS arrival_minutes_after INTEGER NOT NULL DEFAULT 60;

DO $$ BEGIN
  ALTER TABLE call_settings ADD CONSTRAINT call_settings_arrival_time_style_check
    CHECK (arrival_time_style IN ('window', 'scheduled_with_tolerance', 'scheduled_only'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE call_settings ADD CONSTRAINT call_settings_arrival_minutes_check
    CHECK (arrival_minutes_before BETWEEN 0 AND 240 AND arrival_minutes_after BETWEEN 0 AND 240);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
