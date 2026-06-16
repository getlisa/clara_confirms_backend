const { z } = require("zod");
const { interrupt } = require("@langchain/langgraph");
const triggerConfigsDb = require("../../../../db/call-trigger-configs");

const schema = z.object({
  trigger_type: z
    .enum(["scheduled_unconfirmed", "technician_unconfirmed", "open_job_due_soon", "quotation_pending"])
    .describe("Which call trigger to toggle."),
  enabled: z.boolean().describe("true to enable the trigger, false to disable it."),
});

async function run(args, config) {
  const ctx = config?.configurable?.ctx || {};

  const all = await triggerConfigsDb.getAllByCompanyId(ctx.companyId);
  const current = all.find((t) => t.trigger_type === args.trigger_type);
  if (current && current.enabled === args.enabled) {
    return JSON.stringify({
      status: "noop",
      message: `Trigger '${args.trigger_type}' is already ${args.enabled ? "enabled" : "disabled"}.`,
    });
  }

  const preview = {
    entity: "call_trigger",
    trigger_type: args.trigger_type,
    call_type: current?.call_type ?? null,
    from_enabled: current?.enabled ?? null,
    to_enabled: args.enabled,
  };

  const decision = interrupt({ type: "confirm_action", tool: "set_call_trigger_enabled", args, preview });
  if (!decision || decision.decision !== "confirm") {
    return JSON.stringify({ status: "cancelled", message: "The user declined. No change was made. Briefly acknowledge the cancellation; do not ask to confirm again unless the user brings it up." });
  }

  const updated = await triggerConfigsDb.upsert(ctx.companyId, args.trigger_type, { enabled: args.enabled });
  return JSON.stringify({ status: "done", trigger_type: updated.trigger_type, enabled: updated.enabled });
}

module.exports = {
  name: "set_call_trigger_enabled",
  description:
    "Enable or disable a call trigger in configuration — e.g. turn on 'scheduled_unconfirmed' so confirmation calls can be placed/scheduled. Use this when a needed trigger is disabled. Write action: the user confirms before it is applied.",
  isWrite: true,
  schema,
  run,
};
