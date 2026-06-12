-- Per-company voice selection. Falls back to RETELL_DEFAULT_VOICE_ID env var
-- when null (existing behavior). Voice IDs come from Retell's voice catalog
-- (e.g. "11labs-Adrian", "retell-Cimo"); we don't validate against an enum
-- here so the catalog can evolve without DB migrations.

ALTER TABLE agent_settings
  ADD COLUMN IF NOT EXISTS voice_id VARCHAR;
