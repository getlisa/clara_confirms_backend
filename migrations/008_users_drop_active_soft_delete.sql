-- Users: use only is_active (drop duplicate active), support soft delete via is_deleted
-- 1. Sync is_active from active, then drop active and fix index

-- Ensure is_active matches active before dropping
UPDATE users SET is_active = COALESCE(active, true) WHERE active IS NOT NULL;

-- Drop index that references active (recreate with is_active)
DROP INDEX IF EXISTS idx_users_company_role;

-- Drop duplicate column
ALTER TABLE users DROP COLUMN IF EXISTS active;

-- Recreate index for (company_id, role, is_active)
CREATE INDEX IF NOT EXISTS idx_users_company_role ON users(company_id, role, is_active);
