-- Every normalize step currently upserts one row at a time (SELECT to check
-- existence, then INSERT/UPDATE) because no platform table has a real
-- UNIQUE constraint on (company_id, external_ref, source) — only a plain
-- lookup index. At a few thousand rows that's ~2N sequential round trips
-- and starts hitting the DB's statement/query timeout.
--
-- These partial unique indexes (scoped to external_ref IS NOT NULL, so
-- manually-created rows with no CRM link are unaffected) enable real
-- bulk `INSERT ... ON CONFLICT (company_id, external_ref, source) DO UPDATE`
-- upserts — one query per batch instead of two queries per row.
--
-- Verified no existing duplicate (company_id, external_ref, source) groups
-- on any of these tables before writing this migration.

CREATE UNIQUE INDEX IF NOT EXISTS customers_external_ref_source_uq
  ON customers (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS technicians_external_ref_source_uq
  ON technicians (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS jobs_external_ref_source_uq
  ON jobs (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS appointments_external_ref_source_uq
  ON appointments (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS locations_external_ref_source_uq
  ON locations (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_external_ref_source_uq
  ON contacts (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS offices_external_ref_source_uq
  ON offices (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tags_external_ref_source_uq
  ON tags (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_lines_external_ref_source_uq
  ON service_lines (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS deficiencies_external_ref_source_uq
  ON deficiencies (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS change_orders_external_ref_source_uq
  ON change_orders (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contracts_external_ref_source_uq
  ON contracts (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_recurrences_external_ref_source_uq
  ON service_recurrences (company_id, external_ref, source) WHERE external_ref IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS service_opportunities_external_ref_source_uq
  ON service_opportunities (company_id, external_ref, source) WHERE external_ref IS NOT NULL;
