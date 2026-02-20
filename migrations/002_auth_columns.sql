-- Auth columns for users table
-- Adds password_hash and last_login for JWT-based authentication

-- Add password_hash column for storing bcrypt hashed passwords
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);

-- Add last_login column for tracking user login times
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
