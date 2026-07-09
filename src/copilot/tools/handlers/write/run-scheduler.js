const { z } = require("zod");
const { interrupt } = require("@langchain/langgraph");
const scheduler = require("../../../../services/scheduler");
const triggerConfigsDb = require("../../../../db/campaigns");

const schema = z.object({}).describe("No parameters.");

/**
 * Run the scheduler for this company — the same work as POST /engines/scheduler_run:
 * process every enabled trigger and queue all eligible calls into the next
 * business window. Bulk write action, so it is confirmation-gated.
 */
async function run(_args, config) {
  const ctx = config?.configurable?.ctx || {};

  const enabled = await triggerConfigsDb.getEnabledByCompanyId(ctx.companyId);
  if (enabled.length === 0) {
    return JSON.stringify({
      status: "error",
      message:
        "No call triggers are enabled in configuration, so there is nothing to schedule. Enable a trigger first (set_call_trigger_enabled).",
    });
  }

  const preview = {
    entity: "scheduler_run",
    enabled_triggers: enabled.map((t) => ({
      trigger_type: t.trigger_type,
      call_type: t.call_type,
      days_before: t.days_before,
    })),
    note: "Queues all eligible calls across the enabled triggers for the next business window.",
  };

  const decision = interrupt({ type: "confirm_action", tool: "run_scheduler", args: {}, preview });
  if (!decision || decision.decision !== "confirm") {
    return JSON.stringify({ status: "cancelled", message: "The user declined. The scheduler was NOT run. Briefly acknowledge the cancellation; do not ask to confirm again unless the user brings it up." });
  }

  // respectAutoFlag=false: an explicit user action bypasses the auto-schedule toggle
  // (same as the engine route's manual trigger).
  const totals = await scheduler.runDailyJob({ companyId: ctx.companyId, respectAutoFlag: false });
  return JSON.stringify({ status: "done", scheduled: totals.created, skipped: totals.skipped });
}

module.exports = {
  name: "run_scheduler",
  description:
    "Run the scheduler now to queue ALL eligible confirmation/follow-up calls for the next business window, across every enabled call trigger (the same as the platform's 'Run scheduler' action). This is a bulk write action: the user confirms before it runs.",
  isWrite: true,
  schema,
  run,
};
