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

/**
 * One row per LLM call for a thread, oldest first.
 *
 * Used to attach timestamps to a transcript: the LangGraph checkpointer holds
 * the authoritative messages but stores no per-message time, while this table
 * has `created_at` per turn. It is lossy on its own — tool RESULTS are not
 * recorded and `ai_message` is NULL on pure-tool turns — so it supplements the
 * checkpointer rather than replacing it.
 */
async function listTurns(companyId, threadId) {
  const { rows } = await db.query(
    `SELECT human_message, ai_message, created_at
       FROM confirmation_agent_llm_logs
      WHERE company_id = $1 AND thread_id = $2
      ORDER BY id`,
    [companyId, threadId]
  );
  return rows;
}

module.exports = { logCall, listTurns };
