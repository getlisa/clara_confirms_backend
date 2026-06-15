const { z } = require("zod");
const todosDb = require("../../../../db/todos");

const schema = z.object({
  type: z
    .enum([
      "NOT_PICKED",
      "VOICEMAIL",
      "ASKED_FOR_RESCHEDULE",
      "ASKED_FOR_CANCELLATION",
      "UNCONFIRMED",
      "APPOINTMENT_NEEDED",
      "MISSING_PHONE",
    ])
    .nullish()
    .describe("Optionally filter by to-do type."),
  limit: z.number().int().min(1).max(50).nullish().describe("Max number of to-dos to return (default 20)."),
});

async function run({ type, limit }, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  const rows = await todosDb.list(companyId, { status: "open", type, limit: limit ?? 20 });
  return JSON.stringify({
    count: rows.length,
    todos: rows.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      priority: t.priority,
      customer: t.customer ? t.customer.name : null,
      job_id: t.job_id,
      notes: t.notes,
      created_at: t.created_at,
    })),
  });
}

module.exports = {
  name: "list_open_todos",
  description:
    "List open to-dos (action items generated from calls) for the company, optionally filtered by type. Use for questions like 'what to-dos are open?' or 'show me unconfirmed to-dos'.",
  isWrite: false,
  schema,
  run,
};
