-- ServiceTrade job/appointment sync goes job-centric: GET /job for ids,
-- GET /job/{id} for full detail, GET /appointment?jobId={id} for that job's
-- appointments. This captures everything in a real /job/{id} and
-- /appointment payload that was previously dropped (serviceRequests[],
-- notes[], schedulingComments[], tags[], project, contract, externalIds,
-- owner, sales, office, number on jobs; full techs[]/offices[] on
-- appointments) — following the existing convention (locations →
-- contacts/offices/tags in 052, service requests → service_lines/
-- deficiencies/etc in 053): singular relations get an FK column directly on
-- jobs/appointments, one-to-many gets a child-side FK, many-to-many gets a
-- junction table. No existing column is renamed or removed.
--
-- `service_requests` is the one central table for every ServiceTrade service
-- request — job-linked or not — reusing the raw mirror
-- (servicetrade_service_requests) and normalized tables
-- (service_lines/deficiencies/change_orders/contracts/service_recurrences)
-- already shipped in migration 053. `service_opportunities` keeps its
-- existing jobless-only contract, now sourced from this table instead of
-- directly from the raw one.

-- ── service_requests (all requests, job-linked or not) ──────────────────────

CREATE TABLE service_requests (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id                 INTEGER REFERENCES jobs(id) ON DELETE CASCADE,        -- NULL = jobless (service_opportunities qualification, unchanged)
  location_id            INTEGER REFERENCES locations(id) ON DELETE CASCADE,
  service_line_id        INTEGER REFERENCES service_lines(id) ON DELETE SET NULL,
  deficiency_id          INTEGER REFERENCES deficiencies(id) ON DELETE SET NULL,
  change_order_id        INTEGER REFERENCES change_orders(id) ON DELETE SET NULL,
  contract_id            INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
  service_recurrence_id  INTEGER REFERENCES service_recurrences(id) ON DELETE SET NULL,
  status                 VARCHAR,
  description            TEXT,
  window_start           TIMESTAMPTZ,
  window_end             TIMESTAMPTZ,
  closed_on              TIMESTAMPTZ,
  estimated_price        NUMERIC(10, 2),
  duration               INTEGER,
  preferred_start_time   INTEGER,
  asset                  JSONB,
  budget                 JSONB,
  preferred_vendor       JSONB,
  visibility             JSONB,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX service_requests_company_id_idx      ON service_requests (company_id, status);
CREATE INDEX service_requests_job_id_idx          ON service_requests (job_id);
CREATE INDEX service_requests_location_id_idx     ON service_requests (location_id);
CREATE INDEX service_requests_service_line_id_idx ON service_requests (service_line_id);
CREATE UNIQUE INDEX service_requests_external_ref_source_uq
  ON service_requests (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE TABLE service_request_preferred_techs (
  service_request_id INTEGER NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  technician_id       INTEGER NOT NULL REFERENCES technicians(id)      ON DELETE CASCADE,
  UNIQUE (service_request_id, technician_id)
);

-- ── projects (job.project: {id, uri, startDate, endDate}) ───────────────────

CREATE TABLE servicetrade_projects (
  id               BIGSERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id  BIGINT NOT NULL,
  start_date       TIMESTAMPTZ,
  end_date         TIMESTAMPTZ,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_projects_company_idx ON servicetrade_projects (company_id);

CREATE TABLE projects (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  start_date             TIMESTAMPTZ,
  end_date               TIMESTAMPTZ,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_external_ref_source_uq
  ON projects (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

-- ── crm_users (job.owner / job.sales — ServiceTrade "User" refs, lighter
-- weight than a technician record and not necessarily a technician at all) ──

CREATE TABLE servicetrade_users (
  id               BIGSERIAL PRIMARY KEY,
  company_id       BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id  BIGINT NOT NULL,
  name             VARCHAR,
  email            VARCHAR,
  status           VARCHAR,
  is_tech          BOOLEAN,
  is_helper        BOOLEAN,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);
CREATE INDEX servicetrade_users_company_idx ON servicetrade_users (company_id);

CREATE TABLE crm_users (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                   VARCHAR,
  email                  VARCHAR,
  status                 VARCHAR,
  is_tech                BOOLEAN,
  is_helper              BOOLEAN,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX crm_users_external_ref_source_uq
  ON crm_users (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

-- ── scheduling_comments (job.schedulingComments[]: {id, uri, job_id,
-- content}) — real ServiceTrade ids, one-to-many, child-side FK ───────────

CREATE TABLE scheduling_comments (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id                 INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  content                TEXT,
  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduling_comments_job_id_idx ON scheduling_comments (job_id);
CREATE UNIQUE INDEX scheduling_comments_external_ref_source_uq
  ON scheduling_comments (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

-- ── job_notes (job.notes[]: {type, text}) — no id/stable identity in the
-- payload, so no upsert key; re-synced by delete-and-reinsert per job. ──────

CREATE TABLE job_notes (
  id         SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type       VARCHAR,
  text       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX job_notes_job_id_idx ON job_notes (job_id);

-- ── appointment_notes — same idea, for appointment.notes[] ──────────────────

CREATE TABLE appointment_notes (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id)    ON DELETE CASCADE,
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  type           VARCHAR,
  text           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX appointment_notes_appointment_id_idx ON appointment_notes (appointment_id);

-- ── Many-to-many junctions — reuse existing tables (offices, tags,
-- technicians), never the invalid array+REFERENCES pattern. ─────────────────

CREATE TABLE job_offices (
  job_id    INTEGER NOT NULL REFERENCES jobs(id)    ON DELETE CASCADE,
  office_id INTEGER NOT NULL REFERENCES offices(id) ON DELETE CASCADE,
  UNIQUE (job_id, office_id)
);

CREATE TABLE job_tags (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE (job_id, tag_id)
);

-- Multi-tech (appointment.techs[]): appointments.technician_id (7 existing
-- call sites) stays as-is, holding the first/primary tech. This junction
-- carries the full list.
CREATE TABLE appointment_technicians (
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  technician_id  INTEGER NOT NULL REFERENCES technicians(id)  ON DELETE CASCADE,
  UNIQUE (appointment_id, technician_id)
);

CREATE TABLE appointment_offices (
  appointment_id INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  office_id      INTEGER NOT NULL REFERENCES offices(id)      ON DELETE CASCADE,
  UNIQUE (appointment_id, office_id)
);

-- ── Singular relations → FK columns directly on jobs (all additive; no
-- existing column touched). ─────────────────────────────────────────────────

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS job_number             VARCHAR,
  ADD COLUMN IF NOT EXISTS owner_id               INTEGER REFERENCES crm_users(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS salesperson_id         INTEGER REFERENCES crm_users(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS assigned_office_id     INTEGER REFERENCES offices(id)       ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS project_id             INTEGER REFERENCES projects(id)      ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contract_id            INTEGER REFERENCES contracts(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS current_appointment_id INTEGER REFERENCES appointments(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS external_ids           JSONB NOT NULL DEFAULT '{}'::jsonb;  -- flexible map (e.g. {"peachtree": "..."}), not a normalizable entity

CREATE INDEX jobs_owner_id_idx           ON jobs (owner_id);
CREATE INDEX jobs_salesperson_id_idx     ON jobs (salesperson_id);
CREATE INDEX jobs_assigned_office_id_idx ON jobs (assigned_office_id);
CREATE INDEX jobs_project_id_idx         ON jobs (project_id);
CREATE INDEX jobs_contract_id_idx        ON jobs (contract_id);

ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS duration INTEGER,
  ADD COLUMN IF NOT EXISTS released BOOLEAN;
