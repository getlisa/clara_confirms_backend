ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS alert_days_before INTEGER NOT NULL DEFAULT 2
    CHECK (alert_days_before >= 1);
