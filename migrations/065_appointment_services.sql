-- Appointment → service context.
--
-- Confirmed via a real captured GET /appointment/{id} response: an appointment
-- detail (NOT the thin stub embedded on /job) carries `serviceRequests[]`
-- (each with a full `serviceLine` object: id/name/trade/abbr) AND a `job`
-- summary — i.e. ServiceTrade already tells us exactly what service(s) an
-- appointment is for. Today we only ever sync the thin job-embedded appointment
-- stub, and service requests attached to a job/appointment are captured in the
-- raw table but never surfaced anywhere queryable (only job-LESS requests
-- become `service_opportunities` — a separate sales-pipeline concept that must
-- not be touched by this).
--
-- This migration adds the columns/table needed to fix that: track which
-- appointment a service request came from, and a new platform table so a job's
-- or appointment's real service(s) can be queried directly (used to enrich the
-- get_job / get_appointment tool responses with service/service-line context
-- instead of just a bare job title/number).

ALTER TABLE servicetrade_service_requests
  ADD COLUMN IF NOT EXISTS servicetrade_appointment_id BIGINT,
  ADD COLUMN IF NOT EXISTS completion VARCHAR;
CREATE INDEX IF NOT EXISTS servicetrade_service_requests_appointment_idx
  ON servicetrade_service_requests (company_id, servicetrade_appointment_id);

CREATE TABLE IF NOT EXISTS appointment_services (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id)    ON DELETE CASCADE,
  appointment_id         INTEGER NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  job_id                 INTEGER REFERENCES jobs(id)                  ON DELETE SET NULL,
  service_line_id        INTEGER REFERENCES service_lines(id)         ON DELETE SET NULL,

  status                 VARCHAR,
  completion             VARCHAR,
  description            TEXT,
  window_start           TIMESTAMPTZ,
  window_end             TIMESTAMPTZ,
  duration               INTEGER,
  estimated_price        NUMERIC(10, 2),
  asset                  JSONB,

  external_ref           VARCHAR,
  source                 VARCHAR,
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX appointment_services_company_idx     ON appointment_services (company_id);
CREATE INDEX appointment_services_appointment_idx ON appointment_services (company_id, appointment_id);
CREATE INDEX appointment_services_job_idx         ON appointment_services (company_id, job_id);
-- Partial unique index required by db.bulkUpsertByExternalRef's ON CONFLICT arbiter.
CREATE UNIQUE INDEX appointment_services_external_ref_uq
  ON appointment_services (company_id, external_ref, source) WHERE external_ref IS NOT NULL;
