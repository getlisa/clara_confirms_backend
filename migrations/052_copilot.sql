-- ─────────────────────────────────────────────────────────────────────────────
-- AI Copilot: conversations, pending write actions, tool catalog, fuzzy search.
--
-- LangGraph graph state (full message history + paused interrupts) is stored by
-- the PostgresSaver checkpointer in its own tables (checkpoints,
-- checkpoint_writes, checkpoint_blobs), created at boot via checkpointer.setup().
-- The tables below hold only what the platform itself needs to query:
--   - copilot_conversations: thin thread_id ↔ tenant mapping for listing
--   - copilot_pending_actions: proposed write actions awaiting user confirmation
--   - copilot_tool_definitions: enable/disable + catalog of available tools
-- ─────────────────────────────────────────────────────────────────────────────

-- Trigram fuzzy matching for customer name lookup (find_customer tool).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_customers_full_name_trgm
  ON customers USING gin (full_name gin_trgm_ops);

-- ── Conversations ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS copilot_conversations (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   TEXT NOT NULL UNIQUE,            -- LangGraph thread_id (= this conversation)
  company_id  BIGINT NOT NULL,
  user_id     BIGINT,
  title       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_copilot_conversations_company
  ON copilot_conversations (company_id, updated_at DESC);

-- ── Pending write actions (human-in-the-loop) ─────────────────────────────────
CREATE TABLE IF NOT EXISTS copilot_pending_actions (
  id          BIGSERIAL PRIMARY KEY,
  company_id  BIGINT NOT NULL,
  thread_id   TEXT NOT NULL,
  run_id      BIGINT NOT NULL,                 -- engine_runs.id of the turn that proposed it
  user_id     BIGINT,
  tool_name   TEXT NOT NULL,
  args        JSONB NOT NULL,
  preview     JSONB NOT NULL,                  -- human-readable summary shown in the UI
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|executed|rejected|expired|failed
  result      JSONB,
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_copilot_pending_actions_company_status
  ON copilot_pending_actions (company_id, status);
CREATE INDEX IF NOT EXISTS idx_copilot_pending_actions_thread
  ON copilot_pending_actions (thread_id, created_at DESC);

-- ── Tool catalog ──────────────────────────────────────────────────────────────
-- Mirrors tool_definitions (Retell registry) but copilot-specific: no endpoint /
-- speak_* columns. Behaviour + validation live in the JS handler registry; this
-- table is the source of truth for which tools are enabled.
CREATE TABLE IF NOT EXISTS copilot_tool_definitions (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  description   TEXT NOT NULL,
  parameters    JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_write_tool BOOLEAN NOT NULL DEFAULT false,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
