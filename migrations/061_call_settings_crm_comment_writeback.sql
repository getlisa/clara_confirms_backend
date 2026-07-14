-- Per-company toggle for writing call-outcome comments back to the CRM
-- (ServiceTrade). Off by default; each company opts in from the UI.
-- Replaces the SERVICETRADE_COMMENT_WRITEBACK env flag.
ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS crm_comment_writeback_enabled BOOLEAN NOT NULL DEFAULT false;
