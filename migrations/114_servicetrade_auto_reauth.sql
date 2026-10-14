-- Keep ServiceTrade connections permanently live.
--
-- Until now we stored only the PHPSESSID session (migration 007 dropped the
-- plaintext password column), so when ServiceTrade ended a session — which it
-- does with no documented lifetime, and also prunes a user's oldest sessions
-- past 200 concurrent — the company silently stopped syncing until a human
-- reconnected. In production two companies sat dead for 1-3 weeks that way.
--
-- password_encrypted lets the backend log in again on its own. It is
-- AES-256-GCM ciphertext (src/utils/credential-crypto.js, key from
-- CREDENTIAL_ENCRYPTION_KEY) — never plaintext, never logged, never returned
-- by any API.
--
-- last_login_at / auth_error make the connection's health visible: auth_error
-- is set when an automatic re-login fails (e.g. the password was changed in
-- ServiceTrade), which is the one case a human still has to fix.

ALTER TABLE servicetrade_integration
  ADD COLUMN IF NOT EXISTS password_encrypted TEXT        NULL,
  ADD COLUMN IF NOT EXISTS last_login_at      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS auth_error         TEXT        NULL,
  ADD COLUMN IF NOT EXISTS auth_error_at      TIMESTAMPTZ NULL;
