const { z } = require("zod");
const { interrupt } = require("@langchain/langgraph");
const manualCall = require("../../../../services/manual-call");
const { TARGET_FIELD, targetIdFor, summarizeTarget } = require("./call-target");

const schema = z.object({
  trigger_type: z
    .enum(["scheduled_unconfirmed", "technician_unconfirmed", "open_job_due_soon", "quotation_pending"])
    .describe(
      "The kind of call: 'scheduled_unconfirmed' = call the customer to confirm their appointment; " +
        "'technician_unconfirmed' = call the technician to confirm; 'open_job_due_soon' = remind the customer about an open job due soon; " +
        "'quotation_pending' = follow up on a pending quote."
    ),
  appointment_id: z.union([z.string(), z.number()]).nullish().describe("Required for scheduled_unconfirmed / technician_unconfirmed."),
  job_id: z.union([z.string(), z.number()]).nullish().describe("Required for open_job_due_soon."),
  quotation_id: z.union([z.string(), z.number()]).nullish().describe("Required for quotation_pending."),
  force: z.boolean().nullish().describe("Set true to override an existing queued call for the same target."),
});

async function run(args, config) {
  const ctx = config?.configurable?.ctx || {};
  const field = TARGET_FIELD[args.trigger_type];
  const targetId = targetIdFor(args.trigger_type, args);
  if (targetId == null) {
    return JSON.stringify({ status: "error", message: `trigger_type '${args.trigger_type}' requires ${field}.` });
  }

  const target = await summarizeTarget(ctx.companyId, args.trigger_type, args);
  const preview = { entity: "call", mode: "now", trigger_type: args.trigger_type, ...target, force: !!args.force };

  const decision = interrupt({ type: "confirm_action", tool: "make_call", args, preview });
  if (!decision || decision.decision !== "confirm") {
    return JSON.stringify({ status: "cancelled", message: "The user declined. The call was NOT placed. Briefly acknowledge the cancellation; do not ask to confirm again unless the user brings it up." });
  }

  const result = await manualCall.triggerManualCall({
    companyId: ctx.companyId,
    triggerType: args.trigger_type,
    appointmentId: args.appointment_id != null ? Number(args.appointment_id) : undefined,
    jobId: args.job_id != null ? String(args.job_id) : undefined,
    quotationId: args.quotation_id != null ? Number(args.quotation_id) : undefined,
    immediate: true,
    force: !!args.force,
  });

  if (!result.ok) return JSON.stringify({ status: "error", message: result.error });
  return JSON.stringify({
    status: "done",
    dialed: result.dialed,
    retell_call_id: result.retellCallId || null,
    scheduled_call_id: result.scheduledCall?.id ?? null,
  });
}

module.exports = {
  name: "make_call",
  description:
    "Place a call NOW for a customer/appointment/job/quotation (the 'Call now' action). This is a write action: the user confirms before it dials. Choose trigger_type and pass the matching id — resolve ids first via find_customer / get_customer / list_jobs.",
  isWrite: true,
  schema,
  run,
};
