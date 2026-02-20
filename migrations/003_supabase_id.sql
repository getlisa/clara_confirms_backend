-- Add supabase_id column to users table
-- Required for Supabase authentication integration
-- Note: supabase_id remains UUID as it comes from Supabase Auth

-- Add supabase_id column for linking to Supabase Auth users
ALTER TABLE users ADD COLUMN IF NOT EXISTS supabase_id UUID;

-- Create unique index on supabase_id for fast lookups (partial index where not null)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_supabase_id ON users(supabase_id) WHERE supabase_id IS NOT NULL;

-- Add comment explaining the column
COMMENT ON COLUMN users.supabase_id IS 'UUID from Supabase Auth (sub claim in JWT)';
