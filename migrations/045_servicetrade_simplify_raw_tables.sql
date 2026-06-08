-- Simplify the ServiceTrade raw schema so it mirrors the platform domain 1:1.
--
-- Before: 8 tables (companies, locations, contacts, contact_companies, contact_locations,
--                   service_requests, assets, users) — location/contact-centric, mirrors
--                   ServiceTrade's data model rather than our usage.
--
-- After:  4 tables (customers, jobs, appointments, technicians) — one per platform
--                   destination table. Easier to map, query, and reason about.

DROP TABLE IF EXISTS servicetrade_assets             CASCADE;
DROP TABLE IF EXISTS servicetrade_contact_locations  CASCADE;
DROP TABLE IF EXISTS servicetrade_contact_companies  CASCADE;
DROP TABLE IF EXISTS servicetrade_contacts           CASCADE;
DROP TABLE IF EXISTS servicetrade_service_requests   CASCADE;
DROP TABLE IF EXISTS servicetrade_locations          CASCADE;
DROP TABLE IF EXISTS servicetrade_companies          CASCADE;
DROP TABLE IF EXISTS servicetrade_users              CASCADE;

CREATE TABLE servicetrade_customers (
  id              BIGSERIAL PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id BIGINT NOT NULL,
  full_name       VARCHAR,
  email           VARCHAR,
  phone           VARCHAR,
  address_line1   VARCHAR,
  city            VARCHAR,
  state           VARCHAR,
  zipcode         VARCHAR,
  country         VARCHAR DEFAULT 'US',
  is_active       BOOLEAN NOT NULL DEFAULT true,
  payload         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_customers_company_idx ON servicetrade_customers (company_id, is_active);

CREATE TABLE servicetrade_jobs (
  id                        BIGSERIAL PRIMARY KEY,
  company_id                BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id           BIGINT NOT NULL,
  servicetrade_customer_id  BIGINT,            -- soft link to servicetrade_customers.servicetrade_id
  title                     VARCHAR,
  description               TEXT,
  job_type                  VARCHAR,
  status                    VARCHAR,
  scheduled_date            DATE,
  scheduled_window_start    TIMESTAMPTZ,
  scheduled_window_end      TIMESTAMPTZ,
  is_active                 BOOLEAN NOT NULL DEFAULT true,
  payload                   JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_jobs_company_idx  ON servicetrade_jobs (company_id, status);
CREATE INDEX servicetrade_jobs_customer_idx ON servicetrade_jobs (company_id, servicetrade_customer_id);

CREATE TABLE servicetrade_appointments (
  id                          BIGSERIAL PRIMARY KEY,
  company_id                  BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id             BIGINT NOT NULL,
  servicetrade_job_id         BIGINT,
  servicetrade_technician_id  BIGINT,
  status                      VARCHAR,
  scheduled_start             TIMESTAMPTZ,
  scheduled_end               TIMESTAMPTZ,
  payload                     JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_appointments_job_idx ON servicetrade_appointments (company_id, servicetrade_job_id);

CREATE TABLE servicetrade_technicians (
  id              BIGSERIAL PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id BIGINT NOT NULL,
  first_name      VARCHAR,
  last_name       VARCHAR,
  email           VARCHAR,
  phone           VARCHAR,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  payload         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_technicians_company_idx ON servicetrade_technicians (company_id, is_active);

-- Replace cursors on the sync state table
ALTER TABLE servicetrade_sync_state
  DROP COLUMN IF EXISTS last_companies_created_at,
  DROP COLUMN IF EXISTS last_companies_updated_at,
  DROP COLUMN IF EXISTS last_locations_created_at,
  DROP COLUMN IF EXISTS last_locations_updated_at,
  DROP COLUMN IF EXISTS last_contacts_created_at,
  DROP COLUMN IF EXISTS last_contacts_updated_at,
  DROP COLUMN IF EXISTS last_service_requests_created_at,
  DROP COLUMN IF EXISTS last_service_requests_updated_at,
  DROP COLUMN IF EXISTS last_assets_created_at,
  DROP COLUMN IF EXISTS last_assets_updated_at,
  DROP COLUMN IF EXISTS last_users_created_at,
  DROP COLUMN IF EXISTS last_users_updated_at,
  ADD COLUMN IF NOT EXISTS last_customers_created_at    BIGINT,
  ADD COLUMN IF NOT EXISTS last_customers_updated_at    BIGINT,
  ADD COLUMN IF NOT EXISTS last_jobs_created_at         BIGINT,
  ADD COLUMN IF NOT EXISTS last_jobs_updated_at         BIGINT,
  ADD COLUMN IF NOT EXISTS last_appointments_created_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_appointments_updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_technicians_created_at  BIGINT,
  ADD COLUMN IF NOT EXISTS last_technicians_updated_at  BIGINT;
