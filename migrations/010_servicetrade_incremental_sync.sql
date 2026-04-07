-- Upgrade ServiceTrade sync: per-entity dual cursors (createdAfter/updatedAfter)
-- + individual address columns on companies/locations/contacts
-- First sync after migration will be full (all cursors start NULL).

-- ============================================================================
-- 1. servicetrade_sync_state: per-entity cursors + status tracking
-- ============================================================================

ALTER TABLE servicetrade_sync_state
  ADD COLUMN IF NOT EXISTS last_companies_created_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_companies_updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_locations_created_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_locations_updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_contacts_created_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_contacts_updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_service_requests_created_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_service_requests_updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_assets_created_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_assets_updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_full_sync_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_sync_status TEXT,
  ADD COLUMN IF NOT EXISTS last_sync_error TEXT;

-- ============================================================================
-- 2. servicetrade_companies: individual address columns
-- ============================================================================

ALTER TABLE servicetrade_companies
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS ref_number TEXT,
  ADD COLUMN IF NOT EXISTS street TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS postal_code TEXT,
  ADD COLUMN IF NOT EXISTS country TEXT;

-- ============================================================================
-- 3. servicetrade_locations: individual address columns
-- ============================================================================

ALTER TABLE servicetrade_locations
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS ref_number TEXT,
  ADD COLUMN IF NOT EXISTS street TEXT,
  ADD COLUMN IF NOT EXISTS city TEXT,
  ADD COLUMN IF NOT EXISTS state TEXT,
  ADD COLUMN IF NOT EXISTS postal_code TEXT;

-- ============================================================================
-- 4. servicetrade_contacts: alternate_phone + servicetrade_company_id
-- ============================================================================

ALTER TABLE servicetrade_contacts
  ADD COLUMN IF NOT EXISTS alternate_phone TEXT,
  ADD COLUMN IF NOT EXISTS servicetrade_company_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_st_contacts_st_company_id
  ON servicetrade_contacts(company_id, servicetrade_company_id);
