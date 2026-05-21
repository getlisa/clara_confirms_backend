-- One conversation flow + one flow-backed agent per company (replaces per-call-type agents)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS retell_conversation_flow_id VARCHAR;

-- Richer call data from Retell webhook
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS transcript_with_tool_calls JSONB,
  ADD COLUMN IF NOT EXISTS call_cost                  JSONB;
