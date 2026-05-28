-- Global catalog of Retell custom tools.
-- URL is derived at registration time: baseUrl + endpoint + ?company_id=X
-- is_write_tool = true  → only registered when agent_can_make_changes = true
-- sort_order     → controls display order within a call type

CREATE TABLE IF NOT EXISTS tool_definitions (
  id                            SERIAL PRIMARY KEY,
  call_type                     VARCHAR NOT NULL,
  name                          VARCHAR NOT NULL,
  description                   TEXT    NOT NULL,
  endpoint                      VARCHAR NOT NULL,  -- e.g. /retell/tools/get_job
  method                        VARCHAR NOT NULL DEFAULT 'POST',
  parameters                    JSONB,
  speak_during_execution        BOOLEAN NOT NULL DEFAULT true,
  speak_after_execution         BOOLEAN NOT NULL DEFAULT false,
  execution_message_description TEXT,
  is_write_tool                 BOOLEAN NOT NULL DEFAULT false,
  enabled                       BOOLEAN NOT NULL DEFAULT true,
  sort_order                    INTEGER NOT NULL DEFAULT 0,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (call_type, name)
);
