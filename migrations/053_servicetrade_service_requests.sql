-- ServiceTrade service requests → platform `service_opportunities`.
--
-- Source: GET /servicerequest?windowStartBefore=...&windowEndAfter=...&available=true&excludeUnapproved=true
-- (account-wide fetch — no locationName/officeIds scoping; filtering by
-- location/office happens at our platform's service-opportunities API layer.)
--
-- A service request embeds several nested object types, each ingested into
-- its own table (uniqueness enforced by (company_id, servicetrade_id)):
--   serviceLine    → service_lines
--   deficiency     → deficiencies
--   changeOrder    → change_orders
--   contract       → contracts
--   serviceRecurrence → service_recurrences
--   job            → jobs (existing table — stub-inserted only if missing,
--                    never overwritten, since the dedicated /job sync is authoritative)
--   location       → locations (existing table — same stub-insert-only rule;
--                    a service request can reference an inactive/non-customer
--                    location that /location's isCustomer=true&status=active
--                    filter would never have picked up)
--   preferredTechs[] → technicians (existing table) via a junction
--   asset, budget, preferredVendor, visibility — kept as JSONB for now
--   (no dedicated asset/vendor sync built yet)
--
-- Qualification rule for service_opportunities: a service request qualifies
-- only when it has NEITHER a job NOR an appointment — i.e. `job` is null on
-- the ServiceTrade payload. (If a job exists but has no appointment yet, it
-- does not qualify under this rule.)

CREATE TABLE servicetrade_service_lines (
  id               BIGSERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id  BIGINT NOT NULL,
  name             VARCHAR,
  trade            VARCHAR,
  abbr             VARCHAR,
  icon             VARCHAR,
  payload          JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);

CREATE TABLE service_lines (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                   VARCHAR,
  trade                  VARCHAR,
  abbr                   VARCHAR,
  icon                   VARCHAR,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX service_lines_company_id_idx   ON service_lines (company_id);
CREATE INDEX service_lines_external_ref_idx ON service_lines (company_id, external_ref);

CREATE TABLE servicetrade_deficiencies (
  id               BIGSERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id  BIGINT NOT NULL,
  ref_number       VARCHAR,
  name             VARCHAR,
  description      TEXT,
  payload          JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);

CREATE TABLE deficiencies (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  ref_number             VARCHAR,
  name                   VARCHAR,
  description            TEXT,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX deficiencies_company_id_idx   ON deficiencies (company_id);
CREATE INDEX deficiencies_external_ref_idx ON deficiencies (company_id, external_ref);

CREATE TABLE servicetrade_change_orders (
  id                BIGSERIAL PRIMARY KEY,
  company_id        BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id   BIGINT NOT NULL,
  status            VARCHAR,
  type              VARCHAR,
  reference_number  VARCHAR,
  payload           JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);

CREATE TABLE change_orders (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  status                 VARCHAR,
  type                   VARCHAR,
  reference_number       VARCHAR,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX change_orders_company_id_idx   ON change_orders (company_id);
CREATE INDEX change_orders_external_ref_idx ON change_orders (company_id, external_ref);

CREATE TABLE servicetrade_contracts (
  id               BIGSERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id  BIGINT NOT NULL,
  name             VARCHAR,
  payload          JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);

CREATE TABLE contracts (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                   VARCHAR,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX contracts_company_id_idx   ON contracts (company_id);
CREATE INDEX contracts_external_ref_idx ON contracts (company_id, external_ref);

-- "interval" is a reserved word — column is named recurrence_interval instead.
CREATE TABLE servicetrade_service_recurrences (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id      BIGINT NOT NULL,
  description          TEXT,
  frequency            VARCHAR,
  recurrence_interval  INTEGER,
  repeat_weekday       BOOLEAN,
  payload              JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);

CREATE TABLE service_recurrences (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  description            TEXT,
  frequency              VARCHAR,
  recurrence_interval    INTEGER,
  repeat_weekday         BOOLEAN,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX service_recurrences_company_id_idx   ON service_recurrences (company_id);
CREATE INDEX service_recurrences_external_ref_idx ON service_recurrences (company_id, external_ref);

-- ── service requests (main raw table) ───────────────────────────────────────

CREATE TABLE servicetrade_service_requests (
  id                              BIGSERIAL PRIMARY KEY,
  company_id                      BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id                 BIGINT NOT NULL,
  status                          VARCHAR,
  description                     TEXT,
  servicetrade_service_line_id    BIGINT,  -- soft link → servicetrade_service_lines.servicetrade_id
  servicetrade_job_id             BIGINT,  -- soft link → servicetrade_jobs.servicetrade_id (null = no job)
  servicetrade_deficiency_id      BIGINT,  -- soft link → servicetrade_deficiencies.servicetrade_id
  servicetrade_change_order_id    BIGINT,  -- soft link → servicetrade_change_orders.servicetrade_id
  servicetrade_contract_id        BIGINT,  -- soft link → servicetrade_contracts.servicetrade_id
  servicetrade_location_id        BIGINT,  -- soft link → servicetrade_locations.servicetrade_id
  servicetrade_recurrence_id      BIGINT,  -- soft link → servicetrade_service_recurrences.servicetrade_id
  asset                           JSONB,   -- raw embedded object; no dedicated assets table yet
  budget                          JSONB,
  window_start                    TIMESTAMPTZ,
  window_end                      TIMESTAMPTZ,
  closed_on                       TIMESTAMPTZ,
  estimated_price                 NUMERIC(10, 2),
  duration                        INTEGER,
  preferred_start_time             INTEGER,
  preferred_vendor                JSONB,
  visibility                      JSONB,
  payload                         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_service_requests_company_idx  ON servicetrade_service_requests (company_id, status);
CREATE INDEX servicetrade_service_requests_location_idx ON servicetrade_service_requests (company_id, servicetrade_location_id);
CREATE INDEX servicetrade_service_requests_job_idx      ON servicetrade_service_requests (company_id, servicetrade_job_id);

-- ── service_opportunities (the platform-facing central table) ──────────────
-- Only populated for service requests with no job (see qualification rule above).

CREATE TABLE service_opportunities (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  location_id            INTEGER NOT NULL REFERENCES locations(id)         ON DELETE CASCADE,
  job_id                 INTEGER REFERENCES jobs(id)                       ON DELETE SET NULL,
  deficiency_id          INTEGER REFERENCES deficiencies(id)               ON DELETE SET NULL,
  change_order_id        INTEGER REFERENCES change_orders(id)              ON DELETE SET NULL,
  contract_id            INTEGER REFERENCES contracts(id)                  ON DELETE SET NULL,
  service_recurrence_id  INTEGER REFERENCES service_recurrences(id)        ON DELETE SET NULL,
  service_line_id        INTEGER REFERENCES service_lines(id)              ON DELETE SET NULL,

  status                 VARCHAR,
  description            TEXT,
  window_start           TIMESTAMPTZ,
  window_end             TIMESTAMPTZ,
  closed_on              TIMESTAMPTZ,
  estimated_price        NUMERIC(10, 2),
  duration               INTEGER,
  preferred_start_time   INTEGER,
  budget                 JSONB,
  preferred_vendor       JSONB,
  asset                  JSONB,
  visibility             JSONB,

  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX service_opportunities_company_idx      ON service_opportunities (company_id, status);
CREATE INDEX service_opportunities_location_idx     ON service_opportunities (company_id, location_id);
CREATE INDEX service_opportunities_external_ref_idx ON service_opportunities (company_id, external_ref);

CREATE TABLE service_opportunity_preferred_techs (
  service_opportunity_id INTEGER NOT NULL REFERENCES service_opportunities(id) ON DELETE CASCADE,
  technician_id          INTEGER NOT NULL REFERENCES technicians(id)           ON DELETE CASCADE,
  UNIQUE (service_opportunity_id, technician_id)
);

ALTER TABLE servicetrade_sync_state
  ADD COLUMN IF NOT EXISTS last_service_requests_created_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_service_requests_updated_at BIGINT;
