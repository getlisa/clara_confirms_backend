-- Assets: the equipment installed at a location (alarm panel, backflow,
-- extinguishers, riser, …). Until now we kept only the {id,name,type} stub a
-- service request embeds; the asset itself — where it is in the building, its
-- service line, its parent system — was never synced, so Clara could not say
-- WHAT a visit services ("your fire alarm panel in the main electrical room").
--
-- Same raw → normalize → platform pattern as every other CRM entity
-- (045/052/053). Source: ServiceTrade GET /asset (per location, or
-- updatedAfter for incremental runs).

CREATE TABLE IF NOT EXISTS servicetrade_assets (
  id                        BIGSERIAL PRIMARY KEY,
  company_id                BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id           BIGINT NOT NULL,
  servicetrade_location_id  BIGINT,
  type                      VARCHAR,
  name                      VARCHAR,
  status                    VARCHAR,
  payload                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX IF NOT EXISTS servicetrade_assets_location_idx ON servicetrade_assets (company_id, servicetrade_location_id);

CREATE TABLE IF NOT EXISTS assets (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id            INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  service_line_id        INTEGER REFERENCES service_lines(id) ON DELETE SET NULL,
  parent_id              INTEGER REFERENCES assets(id) ON DELETE SET NULL,
  -- CRM type code ("alarm", "backflow", "extinguisher") and its readable label
  -- ("Alarm System"). type 'location' is ServiceTrade's generic "Building"
  -- node, not equipment — kept for the hierarchy, excluded from what Clara says.
  type                   VARCHAR,
  type_label             VARCHAR,
  name                   VARCHAR,
  status                 VARCHAR,
  -- Where it is inside the site ("Main Electrical Room"), lifted out of the
  -- per-type properties because it is the one field every consumer needs.
  location_in_site       VARCHAR,
  -- The CRM's per-type key/values (make, model, zone, monitoring company, …),
  -- verbatim: the key set differs by asset type.
  properties             JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_external_ref_source_uq
  ON assets (company_id, external_ref, source) WHERE external_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS assets_location_idx ON assets (company_id, location_id);

-- The equipment a visit's service is for, and the equipment a deficiency was
-- found on. The JSONB `appointment_services.asset` stub stays for back-compat.
ALTER TABLE appointment_services ADD COLUMN IF NOT EXISTS asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL;
ALTER TABLE deficiencies         ADD COLUMN IF NOT EXISTS asset_id INTEGER REFERENCES assets(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS appointment_services_asset_idx ON appointment_services (asset_id) WHERE asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS deficiencies_asset_idx         ON deficiencies (asset_id) WHERE asset_id IS NOT NULL;

-- How Clara handles open deficiencies on a call (company defaults, editable
-- on the platform; the prompt itself stays editable too):
--   deficiency_mention_enabled   mention open deficiencies at all
--   deficiency_offer_repair      offer that the tech repairs them on the visit
--   deficiency_mention_limit     how many to name unprompted (worst first);
--                                the rest only when the customer asks
ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS deficiency_mention_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS deficiency_offer_repair    BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS deficiency_mention_limit   INTEGER NOT NULL DEFAULT 3;

DO $$ BEGIN
  ALTER TABLE call_settings ADD CONSTRAINT call_settings_deficiency_mention_limit_check
    CHECK (deficiency_mention_limit BETWEEN 1 AND 10);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
