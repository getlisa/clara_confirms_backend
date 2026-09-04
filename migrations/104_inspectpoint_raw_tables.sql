-- InspectPoint raw sync tables — mirrors the shape of
-- 045_servicetrade_simplify_raw_tables.sql (one table per platform
-- destination, (company_id, <crm>_id) UNIQUE, payload JSONB) with one
-- deliberate difference: these stay SLIM. ServiceTrade's raw tables duplicate
-- every scalar field into a typed column; InspectPoint's only promote a
-- column when it is a soft FK, a filter, or a status — everything else
-- (name, email, address, every display field) lives in `payload`. There is no
-- 1:1 InspectPoint-vocabulary-to-platform-vocabulary naming coincidence the
-- way ServiceTrade's "Location" happened to match platform "locations", so
-- these tables are named after the PLATFORM destination they feed, exactly
-- like servicetrade_customers/servicetrade_jobs are.
--
-- `updated_at` on every table is OUR write time (touched on every upsert) —
-- this is what fetchAllByCompanyChunked's `updatedSince` option compares for
-- the normalize watermark. InspectPoint's own `updated_at` field from the API
-- goes in `ip_updated_at` instead; reusing the name would silently break
-- incremental normalize the moment InspectPoint's clock and ours disagree
-- about what "changed since last time" means.

-- ── customers (from Account) ─────────────────────────────────────────────────

CREATE TABLE inspectpoint_customers (
  id              BIGSERIAL PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inspectpoint_id BIGINT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  payload         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ip_updated_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, inspectpoint_id)
);
CREATE INDEX inspectpoint_customers_company_idx ON inspectpoint_customers (company_id, is_active);

-- ── locations (from Building) ────────────────────────────────────────────────

CREATE TABLE inspectpoint_locations (
  id                       BIGSERIAL PRIMARY KEY,
  company_id               BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inspectpoint_id          BIGINT NOT NULL,
  inspectpoint_customer_id BIGINT,   -- soft link -> inspectpoint_customers.inspectpoint_id (Building.account_id)
  payload                  JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ip_updated_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, inspectpoint_id)
);
CREATE INDEX inspectpoint_locations_company_idx  ON inspectpoint_locations (company_id);
CREATE INDEX inspectpoint_locations_customer_idx ON inspectpoint_locations (company_id, inspectpoint_customer_id);

-- ── contacts (from Contact) ──────────────────────────────────────────────────

CREATE TABLE inspectpoint_contacts (
  id                       BIGSERIAL PRIMARY KEY,
  company_id               BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inspectpoint_id          BIGINT NOT NULL,
  inspectpoint_customer_id BIGINT,   -- soft link -> inspectpoint_customers.inspectpoint_id (Contact.account_id)
  payload                  JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ip_updated_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, inspectpoint_id)
);
CREATE INDEX inspectpoint_contacts_company_idx  ON inspectpoint_contacts (company_id);
CREATE INDEX inspectpoint_contacts_customer_idx ON inspectpoint_contacts (company_id, inspectpoint_customer_id);

-- ── technicians (from Technician) ────────────────────────────────────────────

CREATE TABLE inspectpoint_technicians (
  id              BIGSERIAL PRIMARY KEY,
  company_id      BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inspectpoint_id BIGINT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  payload         JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ip_updated_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, inspectpoint_id)
);
CREATE INDEX inspectpoint_technicians_company_idx ON inspectpoint_technicians (company_id, is_active);

-- ── jobs (from Inspection) ───────────────────────────────────────────────────

CREATE TABLE inspectpoint_jobs (
  id                         BIGSERIAL PRIMARY KEY,
  company_id                 BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inspectpoint_id            BIGINT NOT NULL,
  inspectpoint_location_id   BIGINT,   -- soft link -> inspectpoint_locations.inspectpoint_id (Inspection.building_id)
  inspectpoint_customer_id   BIGINT,   -- soft link -> inspectpoint_customers.inspectpoint_id (resolved via building.account_id at raw-write time)
  inspectpoint_technician_id BIGINT,   -- soft link -> inspectpoint_technicians.inspectpoint_id (Inspection.technician_id)
  status_code                TEXT,     -- the full 15-value InspectPoint vocabulary, kept verbatim for the status-mapping step
  scheduled_at               TIMESTAMPTZ,  -- Inspection.scheduled_time_iso — tenant-local instant, already timezone-correct
  due_date                   TIMESTAMPTZ,
  payload                    JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ip_updated_at              TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, inspectpoint_id)
);
CREATE INDEX inspectpoint_jobs_company_idx     ON inspectpoint_jobs (company_id, status_code);
CREATE INDEX inspectpoint_jobs_location_idx    ON inspectpoint_jobs (company_id, inspectpoint_location_id);
CREATE INDEX inspectpoint_jobs_customer_idx    ON inspectpoint_jobs (company_id, inspectpoint_customer_id);
CREATE INDEX inspectpoint_jobs_technician_idx  ON inspectpoint_jobs (company_id, inspectpoint_technician_id);
CREATE INDEX inspectpoint_jobs_scheduled_idx   ON inspectpoint_jobs (company_id, scheduled_at);

-- ── appointments (from Inspection Visit) ─────────────────────────────────────

CREATE TABLE inspectpoint_appointments (
  id                         BIGSERIAL PRIMARY KEY,
  company_id                 BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inspectpoint_id            BIGINT NOT NULL,
  inspectpoint_job_id        BIGINT,   -- soft link -> inspectpoint_jobs.inspectpoint_id (Visit.inspection_id)
  inspectpoint_technician_id BIGINT,   -- soft link -> inspectpoint_technicians.inspectpoint_id (Visit.technician_id)
  visit_status               TEXT,     -- scheduled | started | complete | cancelled | NULL
  scheduled_date             TIMESTAMPTZ,  -- NULLABLE — an unscheduled visit is a real, valid row (see Phase 2 mapping notes)
  payload                    JSONB   NOT NULL DEFAULT '{}'::jsonb,
  ip_updated_at              TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, inspectpoint_id)
);
CREATE INDEX inspectpoint_appointments_job_idx        ON inspectpoint_appointments (company_id, inspectpoint_job_id);
CREATE INDEX inspectpoint_appointments_technician_idx ON inspectpoint_appointments (company_id, inspectpoint_technician_id);

-- ── sync state ────────────────────────────────────────────────────────────────
--
-- TIMESTAMPTZ, not BIGINT unix seconds — ServiceTrade's sync_state uses unix
-- seconds because ServiceTrade's own API speaks unix; InspectPoint speaks ISO
-- 8601 throughout, so there is no conversion to do at the boundary if this
-- table matches.
--
-- Column names encode whether a real incremental filter exists on that
-- endpoint: `_updated_at` = a real `updated_at_start` cursor is applied;
-- `_synced_at` = informational only, that endpoint has no time filter and is
-- always pulled in full. Collapsing these into one naming scheme would let a
-- future reader assume a cursor exists where none does.

CREATE TABLE inspectpoint_sync_state (
  company_id                   BIGINT NOT NULL PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  last_sync_at                 TIMESTAMPTZ,
  last_full_sync_at            TIMESTAMPTZ,
  last_sync_status             TEXT,
  last_sync_error              TEXT,
  last_customers_updated_at    TIMESTAMPTZ,   -- accounts: real updated_at_start cursor
  last_locations_updated_at    TIMESTAMPTZ,   -- buildings: real updated_at_start cursor
  last_jobs_updated_at         TIMESTAMPTZ,   -- inspections: real updated_at_start cursor
  last_contacts_synced_at      TIMESTAMPTZ,   -- no incremental filter exists — informational only
  last_technicians_synced_at   TIMESTAMPTZ,   -- no incremental filter exists — informational only
  last_appointments_synced_at  TIMESTAMPTZ,   -- inspection_visits: filtered by inspection_id, not time — informational only
  last_normalized_at           TIMESTAMPTZ    -- normalize-phase watermark, distinct from the fetch cursors above
);
