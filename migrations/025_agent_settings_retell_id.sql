-- ─────────────────────────────────────────────────────────────────────────────
-- agent_settings: remove columns that belong to call_type_configs,
-- add Retell agent/flow identifiers and subagent count.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE agent_settings
  DROP COLUMN IF EXISTS begin_message,
  DROP COLUMN IF EXISTS general_prompt,
  DROP COLUMN IF EXISTS days_before_confirmation;

ALTER TABLE agent_settings
  ADD COLUMN IF NOT EXISTS retell_agent_id             VARCHAR,
  ADD COLUMN IF NOT EXISTS retell_conversation_flow_id VARCHAR,
  ADD COLUMN IF NOT EXISTS subagent_count              INTEGER NOT NULL DEFAULT 0;

-- Backfill from companies for any existing rows
UPDATE agent_settings a
SET retell_agent_id             = c.retell_agent_id,
    retell_conversation_flow_id = c.retell_conversation_flow_id
FROM companies c
WHERE c.id = a.company_id
  AND c.retell_agent_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- call_type_configs: add subagent node ID column.
-- retell_agent_id and retell_llm_id already exist (added in migration 021).
-- retell_agent_id  → company's Retell agent (same for all types in a company)
-- retell_llm_id    → conversation flow ID (flow is the LLM engine in new arch)
-- retell_subagent_node_id → node ID inside the flow (e.g. node_customer_confirmation)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE call_type_configs
  ADD COLUMN IF NOT EXISTS retell_subagent_node_id VARCHAR;

-- Backfill node IDs (deterministic pattern: node_{type})
UPDATE call_type_configs
SET retell_subagent_node_id = 'node_' || type
WHERE retell_subagent_node_id IS NULL;

-- Backfill agent + flow IDs from companies
UPDATE call_type_configs ctc
SET retell_agent_id = c.retell_agent_id,
    retell_llm_id   = c.retell_conversation_flow_id
FROM companies c
WHERE c.id = ctc.company_id
  AND c.retell_agent_id IS NOT NULL;

-- Backfill subagent_count on agent_settings = count of enabled call types per company
UPDATE agent_settings a
SET subagent_count = (
  SELECT COUNT(*) FROM call_type_configs ctc
  WHERE ctc.company_id = a.company_id AND ctc.enabled = true
);
