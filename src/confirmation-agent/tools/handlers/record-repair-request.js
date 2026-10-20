/**
 * The customer said YES to having the technician repair the open deficiencies
 * on the visit — chat counterpart of retell-tools.js's POST
 * /record_repair_request. Records it for the office (a REPAIR_REQUESTED todo,
 * plus a ServiceTrade job comment when write-back is on). It does not book,
 * schedule or price anything.
 */
const { z } = require("zod");
const { recordRepairRequest } = require("../../../services/repair-requests");
const logger = require("../../../utils/logger");

const schema = z.object({
  items: z.string().describe(
    "Which open items they agreed to: \"all\", their positions in the OPEN ITEMS list (\"1, 3\"), or a short description in the customer's words."
  ),
  notes: z.string().optional().describe("Anything else they said about the repair (timing, access, who to contact)."),
});

async function run({ items, notes }, config) {
  const { companyId, jobId, threadId } = config?.configurable?.ctx || {};
  if (!companyId || !jobId) return JSON.stringify({ success: false, error: "No job in this conversation" });
  try {
    const r = await recordRepairRequest({ companyId, jobId, items, notes: notes || null, retellCallId: threadId || null });
    if (!r.ok) return JSON.stringify({ success: false, error: r.error });
    return JSON.stringify({
      success: true,
      recorded_items: r.items,
      message: "Recorded for the office team. Tell the customer you've passed it to the team — it is NOT booked or scheduled.",
    });
  } catch (err) {
    logger.error("ConfirmationAgent tool: record_repair_request failed", { companyId, jobId, threadId, error: err.message });
    return JSON.stringify({ success: false, error: "Could not record the request" });
  }
}

module.exports = {
  name: "record_repair_request",
  description: "Call this ONLY after the customer says YES to having the technician repair the open deficiencies on this visit. Records what they agreed to so the office can arrange it. It does NOT book, schedule or price the repair — afterwards say you've passed it to the team.",
  schema,
  run,
};
