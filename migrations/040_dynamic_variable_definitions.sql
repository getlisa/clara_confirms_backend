-- Global catalog of dynamic variables used in Retell prompts and tool calls.
-- Each company's conversation flow registers these as default_dynamic_variables
-- so {{var_name}} placeholders are recognized. Real values are injected at
-- call time by the dispatcher.

CREATE TABLE IF NOT EXISTS dynamic_variable_definitions (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR NOT NULL UNIQUE,
  description   TEXT    NOT NULL,
  default_value VARCHAR NOT NULL DEFAULT '',
  resolved_from VARCHAR,   -- documentation: where the runtime value comes from
  enabled       BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
