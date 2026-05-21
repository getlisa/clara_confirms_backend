-- Store full Retell-confirmed configurations so our DB is the source of truth
-- for what is currently live in Retell at any point in time.
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS retell_agent_snapshot  JSONB,
  ADD COLUMN IF NOT EXISTS retell_flow_snapshot   JSONB,
  ADD COLUMN IF NOT EXISTS retell_last_synced_at  TIMESTAMPTZ;
