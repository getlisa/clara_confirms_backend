-- ServiceTrade: store auth token (auth_code) instead of password. Do not store passwords.

ALTER TABLE servicetrade_integration ADD COLUMN IF NOT EXISTS auth_code TEXT;

-- Migrate: existing rows had password; we cannot derive auth_code without re-login. Clear so user reconnects.
UPDATE servicetrade_integration SET auth_code = NULL WHERE auth_code IS NULL;

ALTER TABLE servicetrade_integration DROP COLUMN IF EXISTS password;

