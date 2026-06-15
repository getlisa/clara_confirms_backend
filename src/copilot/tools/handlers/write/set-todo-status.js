const { z } = require("zod");
const { interrupt } = require("@langchain/langgraph");
const db = require("../../../../db");
const todosDb = require("../../../../db/todos");

const schema = z.object({
  todo_id: z.union([z.string(), z.number()]).describe("The id of the to-do to update."),
  status: z
    .enum(["open", "in_progress", "resolved", "dismissed"])
    .describe("The new status for the to-do."),
  notes: z.string().nullish().describe("Optional note explaining the change."),
});

/**
 * Write tool. Runs read-only validation, then calls interrupt() to pause the
 * graph for human confirmation. IMPORTANT: there must be NO side effects before
 * interrupt() — on resume the node re-runs from the top, so the mutation lives
 * strictly after interrupt() returns 'confirm'.
 */
async function run(args, config) {
  const ctx = config?.configurable?.ctx || {};

  const current = await db.query(
    `SELECT id, status, type FROM todos WHERE id = $1 AND company_id = $2`,
    [args.todo_id, ctx.companyId]
  );
  if (current.rows.length === 0) {
    return JSON.stringify({ status: "error", message: `No to-do #${args.todo_id} found.` });
  }
  const row = current.rows[0];
  if (row.status === args.status) {
    return JSON.stringify({ status: "noop", message: `To-do #${row.id} is already '${args.status}'.` });
  }

  const preview = {
    entity: "todo",
    todo_id: row.id,
    todo_type: row.type,
    from_status: row.status,
    to_status: args.status,
    notes: args.notes || null,
  };

  // Pause for confirmation. The orchestrator surfaces this as a `propose` event.
  const decision = interrupt({ type: "confirm_action", tool: "set_todo_status", args, preview });

  if (!decision || decision.decision !== "confirm") {
    return JSON.stringify({ status: "cancelled", message: "The user did not confirm the change." });
  }

  const updated = await todosDb.updateStatus(args.todo_id, ctx.companyId, {
    status: args.status,
    notes: args.notes,
    actorId: ctx.userId,
  });
  if (!updated) {
    return JSON.stringify({ status: "error", message: "To-do could not be updated (not found)." });
  }
  return JSON.stringify({ status: "done", todo_id: updated.id, new_status: updated.status });
}

module.exports = {
  name: "set_todo_status",
  description:
    "Change the status of a to-do (open, in_progress, resolved, or dismissed). This is a write action: the user will be asked to confirm before it is applied.",
  isWrite: true,
  schema,
  run,
};
