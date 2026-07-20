const { z } = require("zod");
const { interrupt } = require("@langchain/langgraph");
const callSettingsDb = require("../../../../db/call-settings");

const FIELDS = [
  "agent_can_make_changes",
  "auto_schedule_enabled",
  "auto_dispatch_enabled",
  "crm_comment_writeback_enabled",
  "service_link_enabled",
  "business_hours_start",
  "business_hours_end",
  "max_attempts",
  "alert_days_before",
];

const schema = z
  .object({
    agent_can_make_changes: z.boolean().nullish().describe("Whether the AI agents are allowed to make changes on calls."),
    auto_schedule_enabled: z.boolean().nullish().describe("Whether confirmation calls are auto-scheduled."),
    auto_dispatch_enabled: z.boolean().nullish().describe("Whether scheduled calls are auto-dispatched by the cron."),
    crm_comment_writeback_enabled: z.boolean().nullish().describe("Whether call-outcome summary comments are written back to the connected CRM (ServiceTrade) after answered calls."),
    service_link_enabled: z.boolean().nullish().describe("Whether the job's ServiceTrade service link is emailed to the customer after they confirm an appointment."),
    business_hours_start: z.string().nullish().describe("Business hours start, 'HH:MM' (24h)."),
    business_hours_end: z.string().nullish().describe("Business hours end, 'HH:MM' (24h)."),
    max_attempts: z.number().int().min(1).max(10).nullish().describe("Max call attempts before giving up."),
    alert_days_before: z.number().int().min(0).max(30).nullish().describe("Days before an appointment to start confirming."),
  })
  .refine((v) => FIELDS.some((f) => v[f] != null), {
    message: "Provide at least one setting to change.",
  });

async function run(args, config) {
  const ctx = config?.configurable?.ctx || {};
  const current = await callSettingsDb.getByCompanyId(ctx.companyId);

  const changes = [];
  for (const f of FIELDS) {
    if (args[f] != null && args[f] !== current[f]) {
      changes.push({ field: f, from: current[f] ?? null, to: args[f] });
    }
  }
  if (changes.length === 0) {
    return JSON.stringify({ status: "noop", message: "No changes — values already match." });
  }

  const preview = { entity: "call_settings", changes };
  const decision = interrupt({ type: "confirm_action", tool: "update_call_settings", args, preview });
  if (!decision || decision.decision !== "confirm") {
    return JSON.stringify({ status: "cancelled", message: "The user declined. No change was made. Briefly acknowledge the cancellation; do not ask to confirm again unless the user brings it up." });
  }

  const fields = {};
  for (const c of changes) fields[c.field] = c.to;
  const updated = await callSettingsDb.upsert(ctx.companyId, fields);
  return JSON.stringify({ status: "done", applied: fields, settings: updated });
}

module.exports = {
  name: "update_call_settings",
  description:
    "Update the company's call/agent settings — e.g. toggle agent_can_make_changes, auto-schedule/auto-dispatch, CRM comment write-back, business hours, max attempts, or alert-days-before. This is a write action: the user will be asked to confirm before it is applied.",
  isWrite: true,
  schema,
  run,
};
