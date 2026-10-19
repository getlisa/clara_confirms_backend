/**
 * record_repair_request — the customer accepted Clara's offer to have the
 * technician repair open deficiencies on the upcoming visit (product decision
 * 2026-10-20: mention the worst few, offer the repair, record the yes).
 *
 * Records it for the office: a REPAIR_REQUESTED todo listing exactly what they
 * agreed to, plus a comment on the ServiceTrade job when CRM comment
 * write-back is on. It does NOT book, schedule or price anything — the prompt
 * forbids Clara from saying it did.
 */

const db = require("../db");
const todosDb = require("../db/todos");
const { buildJobConfirmationContext } = require("./job-confirmation-context");
const { postRepairRequestComment } = require("./servicetrade-comments");
const logger = require("../utils/logger");

/**
 * Turn what the agent sent into the concrete items. Accepts "all", 1-based
 * positions ("1, 3" — the order of open_issue_details), or free text (kept
 * verbatim, so nothing the customer said is lost).
 */
function resolveItems(requested, openItems) {
  const raw = Array.isArray(requested) ? requested.join(", ") : String(requested ?? "").trim();
  if (!raw || /^all\b/i.test(raw)) return openItems.slice();
  const positions = raw.split(/[,\s]+(?:and\s+)?/i).map((x) => Number(x)).filter((n) => Number.isInteger(n));
  if (positions.length && positions.every((n) => n >= 1 && n <= openItems.length) && /^[\d\s,and]+$/i.test(raw)) {
    return [...new Set(positions)].map((n) => openItems[n - 1]);
  }
  return [raw];
}

async function recordRepairRequest({ companyId, jobId, items, notes = null, retellCallId = null }) {
  const ctx = await buildJobConfirmationContext(companyId, jobId);
  if (!ctx.ok) return { ok: false, status: ctx.status || 404, error: ctx.error };
  const next = ctx.appointments?.next || null;
  const openItems = Array.isArray(next?.open_issue_details) ? next.open_issue_details : [];
  const chosen = resolveItems(items, openItems).filter(Boolean);
  if (!chosen.length) return { ok: false, status: 400, error: "No open deficiencies to record for this job" };

  // One open todo per job+conversation: a second call of the tool in the same
  // conversation (customer adds an item) updates it instead of duplicating.
  const { rows: existing } = await db.query(
    `SELECT id, metadata FROM todos
      WHERE company_id = $1 AND type = 'REPAIR_REQUESTED' AND status IN ('open', 'in_progress')
        AND metadata->>'job_id' = $2 AND COALESCE(metadata->>'retell_call_id', '') = COALESCE($3, '')
      LIMIT 1`,
    [companyId, String(jobId), retellCallId]
  );
  const customerName = ctx.job?.customer?.name || ctx.job?.location_name || null;
  const metadata = {
    job_id: String(jobId),
    job_number: ctx.job?.job_number ?? null,
    appointment_id: next?.appointment_id ?? null,
    customer_name: customerName,
    items: [...new Set([...(existing[0]?.metadata?.items || []), ...chosen])],
    notes: notes || existing[0]?.metadata?.notes || null,
    retell_call_id: retellCallId,
    source: "record_repair_request",
  };

  let todoId;
  if (existing[0]) {
    await db.query(`UPDATE todos SET metadata = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(metadata), existing[0].id]);
    todoId = existing[0].id;
  } else {
    const todo = await todosDb.create({ companyId, callId: null, type: todosDb.TODO_TYPES.REPAIR_REQUESTED, metadata, priority: "high" });
    todoId = todo?.id ?? null;
  }

  const comment = await postRepairRequestComment({ companyId, jobId, items: chosen, customerName, retellCallId });
  logger.info("record_repair_request", { companyId, jobId, items: chosen.length, todoId, comment: comment.posted ? "posted" : comment.reason });
  return { ok: true, todo_id: todoId, items: chosen, crm_comment: comment.posted };
}

module.exports = { recordRepairRequest, resolveItems };
