const { z } = require("zod");
const callsDb = require("../../../../db/calls");

const schema = z.object({
  status: z.string().nullish().describe("Optional call status filter (e.g. 'analyzed')."),
  appointment_confirmed: z
    .enum(["yes", "no", "unclear"])
    .nullish()
    .describe("Optional outcome filter."),
  limit: z.number().int().min(1).max(50).nullish().describe("Max calls to return (default 20)."),
});

async function run({ status, appointment_confirmed, limit }, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  const rows = await callsDb.list(companyId, {
    status: status || undefined,
    appointmentConfirmed: appointment_confirmed || undefined,
    limit: limit ?? 20,
  });
  return JSON.stringify({
    count: rows.length,
    calls: rows.map((c) => ({
      id: c.id,
      created_at: c.created_at,
      customer: c.customer ? c.customer.name : null,
      to_number: c.to_number,
      call_type: c.call_type,
      status: c.status,
      appointment_confirmed: c.appointment_confirmed,
      user_sentiment: c.user_sentiment,
      duration_ms: c.duration_ms,
      summary: c.call_summary,
    })),
  });
}

module.exports = {
  name: "list_calls",
  description:
    "List recent call logs for the company (most recent first), optionally filtered by status or appointment outcome. Returns a compact summary per call; use get_call for the full transcript of one call.",
  isWrite: false,
  schema,
  run,
};
