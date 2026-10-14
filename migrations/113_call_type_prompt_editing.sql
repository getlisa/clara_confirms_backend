-- User-editable agent prompts, pushed straight to Retell.
--
-- ── prompt_customized ───────────────────────────────────────────────────────
-- Until now every built-in prompt was "ours": resetDefaultPrompts regenerated
-- it wholesale whenever the code default moved, and several automatic paths do
-- exactly that (pre-visit repair, admin reset-all, `sync-prompts --reset`).
-- Once a user can edit the prompt, those paths would silently erase their
-- work. prompt_customized marks a prompt as the user's: every automatic reset
-- skips it, and only an explicit "Reset to default" clears it.
--
-- Deliberately NOT is_custom: that column already means "a user-created call
-- TYPE" (it gates DELETE and sorts the list). Reusing it would make edited
-- built-in types deletable.
--
-- ── prompt_version ──────────────────────────────────────────────────────────
-- Optimistic concurrency for the editor: a save carries the version it was
-- based on, and a stale one gets a 409 instead of overwriting a teammate.
--
-- ── retell_synced_at / retell_sync_error ────────────────────────────────────
-- A save writes the DB first, then Retell. The two can disagree (Retell down,
-- flow not provisioned yet), and the editor must be able to show that and
-- offer a retry rather than pretend the agent is updated.

ALTER TABLE call_type_configs
  ADD COLUMN IF NOT EXISTS prompt_customized  BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS prompt_version     INTEGER     NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS prompt_updated_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS prompt_updated_by  BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retell_synced_at   TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS retell_sync_error  TEXT        NULL;

-- Every saved version of a prompt, so a bad edit can be rolled back from the
-- UI. Append-only; one row per save / reset / restore.
CREATE TABLE IF NOT EXISTS call_type_prompt_revisions (
  id                BIGSERIAL   PRIMARY KEY,
  company_id        INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type              VARCHAR     NOT NULL,
  version           INTEGER     NOT NULL,
  general_prompt    TEXT        NOT NULL,
  prompt_customized BOOLEAN     NOT NULL,
  source            VARCHAR     NOT NULL CHECK (source IN ('edit', 'reset', 'restore')),
  created_by        BIGINT      NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_type_prompt_revisions_lookup_idx
  ON call_type_prompt_revisions (company_id, type, created_at DESC);
