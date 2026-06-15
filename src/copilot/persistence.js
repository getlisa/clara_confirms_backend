/**
 * Copilot persistence — conversations + pending write actions.
 *
 * Conversation message history is NOT stored here: it lives in the LangGraph
 * PostgresSaver checkpointer, keyed by thread_id. This module holds only the
 * thin tenant-scoped records the platform queries directly. Every function
 * takes companyId and includes it in the WHERE clause for tenant isolation.
 */

const crypto = require("crypto");
const db = require("../db");

// ── Conversations ─────────────────────────────────────────────────────────────

async function createConversation(companyId, userId, title = null) {
  const threadId = `cplt_${crypto.randomUUID()}`;
  const r = await db.query(
    `INSERT INTO copilot_conversations (thread_id, company_id, user_id, title)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [threadId, companyId, userId ?? null, title]
  );
  return r.rows[0];
}

async function getConversation(id, companyId) {
  const r = await db.query(
    `SELECT * FROM copilot_conversations WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  return r.rows[0] || null;
}

async function listConversations(companyId, { limit = 30 } = {}) {
  const r = await db.query(
    `SELECT id, thread_id, title, created_at, updated_at
     FROM copilot_conversations
     WHERE company_id = $1
     ORDER BY updated_at DESC
     LIMIT $2`,
    [companyId, Math.min(Math.max(limit, 1), 100)]
  );
  return r.rows;
}

async function touchConversation(id, companyId) {
  await db.query(
    `UPDATE copilot_conversations SET updated_at = NOW() WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
}

async function setTitleIfEmpty(id, companyId, title) {
  await db.query(
    `UPDATE copilot_conversations SET title = $3, updated_at = NOW()
     WHERE id = $1 AND company_id = $2 AND (title IS NULL OR title = '')`,
    [id, companyId, title]
  );
}

// ── Pending write actions ───────────────────────────────────────────────────

async function createPendingAction({ companyId, threadId, runId, userId, toolName, args, preview }) {
  const r = await db.query(
    `INSERT INTO copilot_pending_actions
       (company_id, thread_id, run_id, user_id, tool_name, args, preview)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [
      companyId, threadId, runId, userId ?? null, toolName,
      JSON.stringify(args ?? {}), JSON.stringify(preview ?? {}),
    ]
  );
  return r.rows[0];
}

async function getPendingAction(id, companyId) {
  const r = await db.query(
    `SELECT * FROM copilot_pending_actions WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  return r.rows[0] || null;
}

/** Latest pending action for a thread — guards against confirming a stale proposal. */
async function getLatestPendingForThread(threadId, companyId) {
  const r = await db.query(
    `SELECT * FROM copilot_pending_actions
     WHERE thread_id = $1 AND company_id = $2 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [threadId, companyId]
  );
  return r.rows[0] || null;
}

async function setPendingActionStatus(id, companyId, status, result = null) {
  const r = await db.query(
    `UPDATE copilot_pending_actions
        SET status = $3,
            result = $4::jsonb,
            resolved_at = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING *`,
    [id, companyId, status, result ? JSON.stringify(result) : null]
  );
  return r.rows[0] || null;
}

module.exports = {
  createConversation,
  getConversation,
  listConversations,
  touchConversation,
  setTitleIfEmpty,
  createPendingAction,
  getPendingAction,
  getLatestPendingForThread,
  setPendingActionStatus,
};
