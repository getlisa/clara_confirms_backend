-- Phone is not a safe uniqueness/identity signal for ServiceTrade-synced
-- customers or technicians — two genuinely distinct real accounts (e.g.
-- multiple franchise locations routing through one central office line)
-- can share a phone number. Enforcing UNIQUE(company_id, phone) meant a
-- legitimate second ServiceTrade customer with a shared phone would fail
-- to sync at all, and the old "adopt by phone" upsert fallback could have
-- silently merged two different real customers' data together.
--
-- Only (company_id, external_ref, source) — i.e. the ServiceTrade id —
-- determines identity for synced rows going forward. That constraint
-- already existed (customers_company_external_ref_uidx /
-- technicians_company_external_ref_uidx, from 046_relax_crm_sync_constraints.sql).

DROP INDEX IF EXISTS customers_company_phone_uidx;
DROP INDEX IF EXISTS technicians_company_phone_uidx;

-- Cleanup: 055_platform_external_ref_unique_indexes.sql added duplicate
-- (company_id, external_ref, source) indexes on tables that already had
-- an equivalent one from 046 — harmless, but redundant index maintenance
-- overhead on every write. Drop the duplicates, keep the originals.
DROP INDEX IF EXISTS customers_external_ref_source_uq;
DROP INDEX IF EXISTS technicians_external_ref_source_uq;
DROP INDEX IF EXISTS jobs_external_ref_source_uq;
DROP INDEX IF EXISTS appointments_external_ref_source_uq;
