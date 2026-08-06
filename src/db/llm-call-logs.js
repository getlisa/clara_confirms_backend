/**
 * One row per LLM call made by the confirmation agent (src/confirmation-agent/)
 * — conversation content (human/AI text, tool calls) plus token usage, so
 * cost/usage is queryable per thread or per company without reconstructing
 * anything from the LangGraph checkpointer (which stores full message
 * history but no token accounting). See migrations/082_confirmation_agent_llm_logs.sql.
 */
const db = require("./index");

async function logCall({
  companyId, jobId = null, threadId, phase = null, provider,
  humanMessage = null, aiMessage = null, toolCalls = null, usage = null,
}) {
  await db.query(
    `INSERT INTO confirmation_agent_llm_logs
       (company_id, job_id, thread_id, phase, provider, human_message, ai_message, tool_calls, input_tokens, output_tokens, total_tokens)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      companyId, jobId, threadId, phase, provider,
      humanMessage, aiMessage,
      toolCalls && toolCalls.length ? JSON.stringify(toolCalls) : null,
      usage?.input_tokens ?? null, usage?.output_tokens ?? null, usage?.total_tokens ?? null,
    ]
  );
}

module.exports = { logCall };
