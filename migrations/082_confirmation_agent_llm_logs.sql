-- Per-LLM-call log for the state-driven confirmation chat agent
-- (src/confirmation-agent/) — what was said/decided plus token usage, one
-- row per model call (a single customer turn can span several if the model
-- calls tools and loops back). Queryable per thread or per company without
-- reconstructing anything from the LangGraph checkpointer, which stores full
-- message history but no token accounting.

CREATE TABLE confirmation_agent_llm_logs (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  thread_id TEXT NOT NULL,          -- chat_links.token
  phase TEXT,                       -- confirming / all_confirmed / no_appointment
  provider TEXT NOT NULL,           -- openai / groq
  human_message TEXT,               -- the customer message that triggered this turn (null on tool-loop re-invocations)
  ai_message TEXT,                  -- the assistant's text reply (null when the turn is pure tool_calls)
  tool_calls JSONB,                 -- [{name, args}] the model decided to call this step, or null
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX confirmation_agent_llm_logs_thread_idx ON confirmation_agent_llm_logs (thread_id, created_at);
CREATE INDEX confirmation_agent_llm_logs_company_idx ON confirmation_agent_llm_logs (company_id, created_at);
