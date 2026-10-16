-- Team access: colleagues on one company account, each with their own login
-- and a role (docs/team-access-frontend.md).
--
-- ── Roles ───────────────────────────────────────────────────────────────────
--   admin      everything; several per company allowed (an admin can promote)
--   developer  calls, syncs, CSV import, operational settings, agent voice/name
--              — NOT the prompt, users, CRM credentials or company profile
--   confirmer  read everything; send confirmations (chat links, email, SMS,
--              confirmation calls) — nothing else
-- What each role may do lives in code (src/auth/permissions.js), not here: three
-- fixed roles don't need permission tables.
--
-- 'user' was the only non-admin role and exactly one row has it (an invite that
-- was never accepted); it becomes 'developer', the closest match.
UPDATE users SET role = 'developer' WHERE role NOT IN ('admin', 'developer', 'confirmer');
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'developer', 'confirmer'));
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'developer';

-- ── Owner ───────────────────────────────────────────────────────────────────
-- Exactly one owner per company: an admin who can't be demoted, deactivated or
-- removed, so a company can never lock itself out. Ownership moves only by an
-- explicit transfer. Every company today has exactly one admin, its oldest
-- non-deleted admin becomes the owner.
--
-- token_version is embedded in every access/refresh token. Bumping it (role
-- change, deactivation, removal, password change) invalidates that user's
-- existing tokens immediately instead of letting them live out their 1h/7d.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_owner      BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS token_version INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS invited_by    BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS joined_at     TIMESTAMPTZ NULL;

UPDATE users u SET is_owner = true
  FROM (
    SELECT DISTINCT ON (company_id) id
      FROM users
     WHERE role = 'admin' AND is_deleted = false
     ORDER BY company_id, created_at, id
  ) o
 WHERE u.id = o.id
   AND NOT EXISTS (SELECT 1 FROM users x WHERE x.company_id = u.company_id AND x.is_owner AND NOT x.is_deleted);

CREATE UNIQUE INDEX IF NOT EXISTS users_one_owner_per_company
  ON users (company_id) WHERE is_owner AND NOT is_deleted;

-- ── Invitations ─────────────────────────────────────────────────────────────
-- The user row is created only when an invitation is ACCEPTED. The old flow
-- inserted a password-less user at invite time, which counted toward the seat
-- limit, blocked the email forever if never accepted, and couldn't be resent
-- or revoked. Only the SHA-256 of the emailed token is stored.
CREATE TABLE IF NOT EXISTS user_invitations (
  id               BIGSERIAL   PRIMARY KEY,
  company_id       BIGINT      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email            TEXT        NOT NULL,
  role             TEXT        NOT NULL CHECK (role IN ('admin', 'developer', 'confirmer')),
  first_name       TEXT        NULL,
  last_name        TEXT        NULL,
  token_hash       TEXT        NOT NULL UNIQUE,
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by       BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  expires_at       TIMESTAMPTZ NOT NULL,
  sent_count       INTEGER     NOT NULL DEFAULT 1,
  last_sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at      TIMESTAMPTZ NULL,
  accepted_user_id BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  revoked_at       TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One open invitation per email per company. Emails are stored lower-cased.
CREATE UNIQUE INDEX IF NOT EXISTS user_invitations_one_pending
  ON user_invitations (company_id, email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS user_invitations_company_idx
  ON user_invitations (company_id, status, created_at DESC);

-- Users invited under the OLD flow (a password-less users row) are left as-is:
-- their emailed link still works through /auth/reset-password until it
-- expires, and an admin can remove the row and re-invite at any time.

-- ── Audit log ───────────────────────────────────────────────────────────────
-- Once several people share an account, "who did this?" is the first support
-- question. Team events are written from the start; more actions can follow.
CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL   PRIMARY KEY,
  company_id    BIGINT      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_user_id BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT        NOT NULL,
  target_type   TEXT        NULL,
  target_id     TEXT        NULL,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_company_idx ON audit_log (company_id, created_at DESC);
