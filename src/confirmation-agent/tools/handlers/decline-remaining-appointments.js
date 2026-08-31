/**
 * The customer answered the agent's "want to confirm the rest too?" question
 * with "not now." No appointment write — this only stamps that the question
 * was asked and answered (actions.js's declineRemainingCore), so
 * POST /:token/end stops refusing to close the conversation.
 *
 * Reachable two ways: a card-driven exclusive turn (actions.js's
 * CARD_TRIGGER_PREFIX, graph/build.js's exclusiveTool wiring), or ordinary
 * free-text phase gating (tools/registry.js's PHASE_TOOLS) — the model calls
 * this itself when a customer types "not now" to graph/prompt.js's OTHER
 * APPOINTMENTS ON THIS JOB section. Without the free-text path, a
 * conversation that never touched a card had no way to ever stamp
 * remaining_addressed_at, and POST /:token/end would 409 forever.
 */
const { z } = require("zod");
const { declineRemainingCore } = require("../../actions");

const schema = z.object({});

async function run(_args, config) {
  const { companyId, threadId } = config?.configurable?.ctx || {};
  const result = await declineRemainingCore({ companyId, threadId });
  return JSON.stringify(result);
}

module.exports = {
  name: "decline_remaining_appointments",
  description: "Record that the customer does not want to confirm the other upcoming appointments on this job right now.",
  schema,
  run,
};
