ALTER TABLE call_settings ADD COLUMN IF NOT EXISTS agent_can_make_changes BOOLEAN NOT NULL DEFAULT true;
