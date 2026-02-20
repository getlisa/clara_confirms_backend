-- Users: first_name, last_name (replace single name)
-- Companies: address fields

-- ============================================================================
-- Users: add first_name, last_name; migrate from name; drop name
-- ============================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);

-- Backfill: first word -> first_name, rest -> last_name
UPDATE users
SET
  first_name = COALESCE(trim(split_part(name, ' ', 1)), ''),
  last_name  = COALESCE(trim(substring(name from position(' ' in name || ' ') + 1)), '')
WHERE first_name IS NULL OR last_name IS NULL;

UPDATE users SET first_name = '' WHERE first_name IS NULL;
UPDATE users SET last_name = '' WHERE last_name IS NULL;

ALTER TABLE users ALTER COLUMN first_name SET NOT NULL;
ALTER TABLE users ALTER COLUMN first_name SET DEFAULT '';
ALTER TABLE users ALTER COLUMN last_name SET NOT NULL;
ALTER TABLE users ALTER COLUMN last_name SET DEFAULT '';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'name') THEN
    ALTER TABLE users DROP COLUMN name;
  END IF;
END $$;

-- ============================================================================
-- Companies: address fields
-- ============================================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS address_line1 VARCHAR(500);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS city VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS state VARCHAR(255);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS zipcode VARCHAR(50);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country VARCHAR(255);
