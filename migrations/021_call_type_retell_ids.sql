ALTER TABLE call_type_configs
  ADD COLUMN IF NOT EXISTS retell_llm_id   VARCHAR,
  ADD COLUMN IF NOT EXISTS retell_agent_id VARCHAR;
