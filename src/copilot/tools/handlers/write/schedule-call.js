const { z } = require("zod");
const { interrupt } = require("@langchain/langgraph");
const manualCall = require("../../../../services/manual-call");
const { parseCallbackTime } = require("../../../../services/callback-time");
const { TARGET_FIELD, targetIdFor, summarizeTarget, companyTimezone } = require("./call-target");

const schema = z.object({
  trigger_type: z
    .enum(["scheduled_unconfirmed", "technician_unconfirmed", "open_job_due_soon", "quotation_pending"])
    .describe("Same meanings as make_call's trigger_type."),
  appointment_id: z.union([z.string(), z.number()]).nullish().describe("Required for scheduled_unconfirmed / technician_unconfirmed."),
  job_id: z.union([z.string(), z.number()]).nullish().describe("Required for open_job_due_soon."),
  quotation_id: z.union([z.string(), z.number()]).nullish().describe("Required for quotation_pending."),
  when: z
    .string()
    .describe(
      "When to place the call. Accepts ISO 8601 (e.g. '2026-06-16T14:00:00'), a clock time ('2:30 PM', '14:00'), " +
        "or a relative duration ('in 30 minutes', 'in an hour'). Interpreted in the company's timezone."
    ),
  force: z.boolean().nullish().describe("Set true to override an existing queued call for the same target."),
});

function resolveWhen(whenStr, tz) {
  const dt = parseCallbackTime(whenStr, tz);
  return dt && !isNaN(dt.getTime()) ? dt : null;
}

async function run(args, config) {
  const ctx = config?.configurable?.ctx || {};
  const field = TARGET_FIELD[args.trigger_type];
  const targetId = targetIdFor(args.trigger_type, args);
  if (targetId == null) {
    return JSON.stringify({ status: "error", message: `trigger_type '${args.trigger_type}' requires ${field}.` });
  }

  const tz = await companyTimezone(ctx.companyId);
  const when = resolveWhen(args.when, tz);
  if (!when) {
    return JSON.stringify({ status: "error", message: `Could not understand the time "${args.when}".` });
  }

  const target = await summarizeTarget(ctx.companyId, args.trigger_type, args);
  const preview = {
    entity: "call",
    mode: "scheduled",
    trigger_type: args.trigger_type,
    scheduled_for: when.toISOString(),
    timezone: tz,
    ...target,
    force: !!args.force,
  };

  const decision = interrupt({ type: "confirm_action", tool: "schedule_call", args, preview });
  if (!decision || decision.decision !== "confirm") {
    return JSON.stringify({ status: "cancelled", message: "The user declined. Nothing was scheduled. Briefly acknowledge the cancellation; do not ask to confirm again unless the user brings it up." });
  }

  // Re-resolve at confirm time so relative durations ("in 30 minutes") anchor to now.
  const fireAt = resolveWhen(args.when, tz) || when;

  const result = await manualCall.triggerManualCall({
    companyId: ctx.companyId,
    triggerType: args.trigger_type,
    appointmentId: args.appointment_id != null ? Number(args.appointment_id) : undefined,
    jobId: args.job_id != null ? String(args.job_id) : undefined,
    quotationId: args.quotation_id != null ? Number(args.quotation_id) : undefined,
    immediate: false,
    scheduledAt: fireAt.toISOString(),
    force: !!args.force,
  });

  if (!result.ok) return JSON.stringify({ status: "error", message: result.error });
  return JSON.stringify({
    status: "done",
    scheduled_call_id: result.scheduledCall?.id ?? null,
    scheduled_for: result.scheduledCall?.scheduled_at ?? fireAt.toISOString(),
  });
}

module.exports = {
  name: "schedule_call",
  description:
    "Schedule a call for a LATER time for a customer/appointment/job/quotation. This is a write action: the user confirms before it is queued. Choose trigger_type, pass the matching id (resolve via find_customer / get_customer / list_jobs first), and a `when` time. The call is queued and dispatched at that time (snapped into business hours if needed).",
  isWrite: true,
  schema,
  run,
};
