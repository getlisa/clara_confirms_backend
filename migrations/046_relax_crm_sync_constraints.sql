-- ─────────────────────────────────────────────────────────────────────────────
-- Relax NOT NULL / UNIQUE constraints on core domain tables so CRM sync can
-- always land records even when upstream data is incomplete (missing phone,
-- orphaned job, etc). Each incomplete row is tagged with a warning written to
-- `additional_information.warnings` so the UI can flag it for the user.
--
-- Replaces the old strict UNIQUE(company_id, phone) with a partial unique on
-- phone (only when phone is present) plus a UNIQUE(company_id, external_ref,
-- source) so CRM-sourced rows still de-duplicate cleanly.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── customers ────────────────────────────────────────────────────────────────
ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_company_id_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS customers_company_phone_uidx
  ON customers (company_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_company_external_ref_uidx
  ON customers (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

-- ── technicians ──────────────────────────────────────────────────────────────
ALTER TABLE technicians ALTER COLUMN first_name DROP NOT NULL;
ALTER TABLE technicians ALTER COLUMN last_name  DROP NOT NULL;
ALTER TABLE technicians ALTER COLUMN phone      DROP NOT NULL;
ALTER TABLE technicians DROP CONSTRAINT IF EXISTS technicians_company_id_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS technicians_company_phone_uidx
  ON technicians (company_id, phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS technicians_company_external_ref_uidx
  ON technicians (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

-- ── jobs ─────────────────────────────────────────────────────────────────────
ALTER TABLE jobs ALTER COLUMN customer_id DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_company_external_ref_uidx
  ON jobs (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

-- ── appointments ─────────────────────────────────────────────────────────────
ALTER TABLE appointments ALTER COLUMN job_id          DROP NOT NULL;
ALTER TABLE appointments ALTER COLUMN scheduled_start DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS appointments_company_external_ref_uidx
  ON appointments (company_id, external_ref, source) WHERE external_ref IS NOT NULL;
