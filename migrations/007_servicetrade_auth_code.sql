-- ServiceTrade: store auth token (auth_code) instead of password. Do not store passwords.

ALTER TABLE company_servicetrade ADD COLUMN IF NOT EXISTS auth_code TEXT;

-- Migrate: existing rows had password; we cannot derive auth_code without re-login. Clear so user reconnects.
UPDATE company_servicetrade SET auth_code = NULL WHERE auth_code IS NULL;

ALTER TABLE company_servicetrade DROP COLUMN IF EXISTS password;

