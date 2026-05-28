-- ─────────────────────────────────────────────────────────────────────────────
-- Core domain tables for the Clara Confirms scheduling + confirmation system.
--
-- These tables are fully standalone — no dependencies on servicetrade_*,
-- CSV imports, or any CRM. Integration with external systems is handled
-- separately by writing to these tables.
--
-- Every table has:
--   external_ref  VARCHAR  — optional traceability back to any source system
--   source        VARCHAR  — which system the record came from
--   additional_information JSONB — flexible overflow for any extra fields
-- ─────────────────────────────────────────────────────────────────────────────


-- ── customers ─────────────────────────────────────────────────────────────────

CREATE TABLE customers (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  first_name             VARCHAR,
  last_name              VARCHAR,
  full_name              VARCHAR,
  email                  VARCHAR,
  phone                  VARCHAR NOT NULL,
  alternate_phone        VARCHAR,

  address_line1          VARCHAR,
  city                   VARCHAR,
  state                  VARCHAR,
  zipcode                VARCHAR,
  country                VARCHAR DEFAULT 'US',

  is_active              BOOLEAN NOT NULL DEFAULT true,

  external_ref           VARCHAR,
  source                 VARCHAR,

  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (company_id, phone)
);

CREATE INDEX customers_company_id_idx    ON customers (company_id);
CREATE INDEX customers_external_ref_idx  ON customers (company_id, external_ref);


-- ── technicians ───────────────────────────────────────────────────────────────

CREATE TABLE technicians (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  first_name             VARCHAR NOT NULL,
  last_name              VARCHAR NOT NULL,
  email                  VARCHAR,
  phone                  VARCHAR NOT NULL,

  is_active              BOOLEAN NOT NULL DEFAULT true,
  is_available           BOOLEAN NOT NULL DEFAULT true,

  external_ref           VARCHAR,
  source                 VARCHAR,

  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (company_id, phone)
);

CREATE INDEX technicians_company_id_idx  ON technicians (company_id);
CREATE INDEX technicians_is_active_idx   ON technicians (company_id, is_active);
CREATE INDEX technicians_external_ref_idx ON technicians (company_id, external_ref);


-- ── jobs ──────────────────────────────────────────────────────────────────────

CREATE TABLE jobs (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  customer_id            INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  technician_id          INTEGER REFERENCES technicians(id) ON DELETE SET NULL,

  title                  VARCHAR,
  description            TEXT,
  job_type               VARCHAR,

  status                 VARCHAR NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','scheduled','confirmed','in_progress','completed','cancelled')),

  scheduled_date         DATE,
  scheduled_window_start TIMESTAMPTZ,
  scheduled_window_end   TIMESTAMPTZ,

  external_ref           VARCHAR,
  source                 VARCHAR,

  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX jobs_company_id_idx       ON jobs (company_id);
CREATE INDEX jobs_customer_id_idx      ON jobs (customer_id);
CREATE INDEX jobs_technician_id_idx    ON jobs (technician_id);
CREATE INDEX jobs_status_idx           ON jobs (company_id, status);
CREATE INDEX jobs_scheduled_date_idx   ON jobs (company_id, scheduled_date);
CREATE INDEX jobs_external_ref_idx     ON jobs (company_id, external_ref);


-- ── appointments ──────────────────────────────────────────────────────────────

CREATE TABLE appointments (
  id                      SERIAL PRIMARY KEY,
  company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id                  INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  technician_id           INTEGER REFERENCES technicians(id) ON DELETE SET NULL,

  scheduled_start         TIMESTAMPTZ NOT NULL,
  scheduled_end           TIMESTAMPTZ,

  status                  VARCHAR NOT NULL DEFAULT 'scheduled'
                          CHECK (status IN ('scheduled','confirmed','rescheduled','cancelled','completed','no_show')),

  customer_confirmed      BOOLEAN,
  technician_confirmed    BOOLEAN,
  customer_confirmed_at   TIMESTAMPTZ,
  technician_confirmed_at TIMESTAMPTZ,

  reschedule_requested    BOOLEAN NOT NULL DEFAULT false,
  rescheduled_to          TIMESTAMPTZ,
  previous_appointment_id INTEGER REFERENCES appointments(id) ON DELETE SET NULL,

  cancellation_reason     TEXT,

  external_ref            VARCHAR,
  source                  VARCHAR,

  additional_information  JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX appointments_job_id_idx           ON appointments (job_id);
CREATE INDEX appointments_company_status_idx   ON appointments (company_id, status);
CREATE INDEX appointments_scheduled_start_idx  ON appointments (company_id, scheduled_start);
CREATE INDEX appointments_technician_idx       ON appointments (technician_id, scheduled_start);
CREATE INDEX appointments_external_ref_idx     ON appointments (company_id, external_ref);


-- ── quotations ────────────────────────────────────────────────────────────────

CREATE TABLE quotations (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  customer_id            INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  job_id                 INTEGER REFERENCES jobs(id) ON DELETE SET NULL,

  quote_number           VARCHAR,
  title                  VARCHAR,
  status                 VARCHAR NOT NULL DEFAULT 'draft'
                         CHECK (status IN ('draft','sent','viewed','accepted','rejected','expired')),

  total_amount           NUMERIC(10, 2),
  currency               VARCHAR NOT NULL DEFAULT 'USD',
  valid_until            DATE,

  line_items             JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes                  TEXT,

  external_ref           VARCHAR,
  source                 VARCHAR,

  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX quotations_customer_id_idx  ON quotations (customer_id);
CREATE INDEX quotations_job_id_idx       ON quotations (job_id);
CREATE INDEX quotations_company_idx      ON quotations (company_id, status);
CREATE INDEX quotations_external_ref_idx ON quotations (company_id, external_ref);
