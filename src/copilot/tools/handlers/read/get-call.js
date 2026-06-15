const { z } = require("zod");
const callsDb = require("../../../../db/calls");

const schema = z.object({
  call_id: z.union([z.string(), z.number()]).describe("The id of the call log to retrieve."),
});

async function run({ call_id }, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  const call = await callsDb.getById(call_id, companyId);
  if (!call) return JSON.stringify({ status: "not_found", call_id });
  return JSON.stringify({ status: "ok", call });
}

module.exports = {
  name: "get_call",
  description:
    "Get the full details of a single call log: summary, sentiment, outcome (confirmed/reschedule/cancellation), customer, and the full transcript. Use to answer detailed questions about a specific call.",
  isWrite: false,
  schema,
  run,
};
