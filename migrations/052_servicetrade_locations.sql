-- ServiceTrade locations: 5th synced entity, added on its own following the
-- existing raw → normalize → platform pattern (see 045_servicetrade_simplify_raw_tables.sql).
--
-- Source: GET /location?isCustomer=true&status=active&companyStatus=active
--
-- A location's payload embeds three nested object types that the platform
-- models as their own tables (not JSONB blobs), per the target shape:
--   primaryContact  → contacts (1 per location, FK)
--   offices[]       → offices  (many per location, junction)
--   tags[]          → tags     (many per location, junction)
-- `company` (a lightweight {id,name,status} stub) stays JSONB, but we also
-- resolve a real customer_id FK from it (same pattern as servicetrade_jobs
-- → jobs.customer_id) so locations can be queried/joined by customer.

-- ── contacts (from location.primaryContact) ─────────────────────────────────

CREATE TABLE servicetrade_contacts (
  id               BIGSERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id  BIGINT NOT NULL,
  first_name       VARCHAR,
  last_name        VARCHAR,
  phone            VARCHAR,
  mobile           VARCHAR,
  alternate_phone  VARCHAR,
  email            VARCHAR,
  type             VARCHAR,
  payload          JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_contacts_company_idx ON servicetrade_contacts (company_id);

CREATE TABLE contacts (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  first_name             VARCHAR,
  last_name              VARCHAR,
  phone                  VARCHAR,           -- E.164
  mobile                 VARCHAR,           -- E.164
  alternate_phone        VARCHAR,           -- E.164
  email                  VARCHAR,
  type                   VARCHAR,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX contacts_company_id_idx   ON contacts (company_id);
CREATE INDEX contacts_external_ref_idx ON contacts (company_id, external_ref);

-- ── offices (from location.offices[]) ───────────────────────────────────────
-- ServiceTrade models an "office" as a location-shaped object (its `uri` even
-- points at /location/{id}), but it's a distinct entity on our platform — a
-- location can be served by more than one office (location_offices junction).

CREATE TABLE servicetrade_offices (
  id               BIGSERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id  BIGINT NOT NULL,
  name             VARCHAR,
  address_line1    VARCHAR,
  city             VARCHAR,
  state            VARCHAR,
  zipcode          VARCHAR,
  country          VARCHAR DEFAULT 'US',
  lat              DOUBLE PRECISION,
  lon              DOUBLE PRECISION,
  phone            VARCHAR,
  email            VARCHAR,
  status           VARCHAR,
  is_active        BOOLEAN NOT NULL DEFAULT true,
  payload          JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_offices_company_idx ON servicetrade_offices (company_id, is_active);

CREATE TABLE offices (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                   VARCHAR,
  address_line1          VARCHAR,
  city                   VARCHAR,
  state                  VARCHAR,
  zipcode                VARCHAR,
  country                VARCHAR DEFAULT 'US',
  lat                    DOUBLE PRECISION,
  lon                    DOUBLE PRECISION,
  phone                  VARCHAR,           -- E.164
  email                  VARCHAR,
  is_active              BOOLEAN NOT NULL DEFAULT true,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX offices_company_id_idx   ON offices (company_id, is_active);
CREATE INDEX offices_external_ref_idx ON offices (company_id, external_ref);

-- ── tags (from location.tags[]) ─────────────────────────────────────────────

CREATE TABLE servicetrade_tags (
  id               BIGSERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id  BIGINT NOT NULL,
  name             VARCHAR,
  payload          JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);

CREATE TABLE tags (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                   VARCHAR,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX tags_company_id_idx   ON tags (company_id);
CREATE INDEX tags_external_ref_idx ON tags (company_id, external_ref);

-- ── locations (the fundamental entity) ──────────────────────────────────────

CREATE TABLE servicetrade_locations (
  id                                BIGSERIAL PRIMARY KEY,
  company_id                        BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id                   BIGINT NOT NULL,
  servicetrade_customer_id          BIGINT,   -- soft link → servicetrade_customers.servicetrade_id (from company.id)
  servicetrade_primary_contact_id   BIGINT,   -- soft link → servicetrade_contacts.servicetrade_id (from primaryContact.id)
  name                              VARCHAR,
  lat                               DOUBLE PRECISION,
  lon                               DOUBLE PRECISION,
  phone                             VARCHAR,
  email                             VARCHAR,
  general_manager_name              VARCHAR,  -- plain display-name string in ServiceTrade, not a contact record
  address_line1                     VARCHAR,
  city                              VARCHAR,
  state                             VARCHAR,
  zipcode                           VARCHAR,
  country                           VARCHAR DEFAULT 'US',
  taxable                           BOOLEAN,
  company                           JSONB,    -- raw {id,name,status,uri} stub, kept denormalized
  brand                             JSONB,
  status                            VARCHAR,
  is_active                         BOOLEAN NOT NULL DEFAULT true,
  payload                           JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_locations_company_idx  ON servicetrade_locations (company_id, is_active);
CREATE INDEX servicetrade_locations_customer_idx ON servicetrade_locations (company_id, servicetrade_customer_id);

CREATE TABLE locations (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  customer_id            INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  primary_contact_id     INTEGER REFERENCES contacts(id)  ON DELETE SET NULL,

  name                   VARCHAR,
  lat                    DOUBLE PRECISION,
  lon                    DOUBLE PRECISION,
  phone                  VARCHAR,           -- E.164
  email                  VARCHAR,
  general_manager_name   VARCHAR,
  address_line1          VARCHAR,
  city                   VARCHAR,
  state                  VARCHAR,
  zipcode                VARCHAR,
  country                VARCHAR DEFAULT 'US',
  taxable                BOOLEAN,
  company                JSONB,
  brand                  JSONB,
  is_active              BOOLEAN NOT NULL DEFAULT true,

  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX locations_company_id_idx   ON locations (company_id, is_active);
CREATE INDEX locations_customer_id_idx  ON locations (company_id, customer_id);
CREATE INDEX locations_external_ref_idx ON locations (company_id, external_ref);

-- ── junctions (offices/tags are many-to-many with locations) ───────────────

CREATE TABLE location_offices (
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  office_id   INTEGER NOT NULL REFERENCES offices(id)   ON DELETE CASCADE,
  UNIQUE (location_id, office_id)
);

CREATE TABLE location_tags (
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id)       ON DELETE CASCADE,
  UNIQUE (location_id, tag_id)
);

-- ── sync cursor (locations only — contacts/offices/tags are embedded and
--    re-derived fully every locations sync, same as job_tags today) ────────

ALTER TABLE servicetrade_sync_state
  ADD COLUMN IF NOT EXISTS last_locations_created_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_locations_updated_at BIGINT;
