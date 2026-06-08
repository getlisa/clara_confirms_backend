-- ServiceTrade users (technicians + back-office) raw table + sync cursors.
-- Raw payloads are kept lossless in `payload` JSONB. Techs (is_tech=true)
-- are also normalized into the platform `technicians` table by the sync layer.

CREATE TABLE IF NOT EXISTS servicetrade_users (
  id              BIGSERIAL PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id BIGINT NOT NULL,
  first_name      VARCHAR,
  last_name       VARCHAR,
  email           VARCHAR,
  phone           VARCHAR,
  is_tech         BOOLEAN NOT NULL DEFAULT false,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  payload         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);

CREATE INDEX IF NOT EXISTS servicetrade_users_company_idx
  ON servicetrade_users (company_id, is_tech);

-- Dual-cursor tracking for incremental sync of users (mirrors other entities)
ALTER TABLE servicetrade_sync_state
  ADD COLUMN IF NOT EXISTS last_users_created_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_users_updated_at BIGINT;
