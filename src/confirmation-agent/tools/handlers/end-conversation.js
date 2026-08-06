/**
 * Explicit termination signal. Replaces the old design's heuristic "detect a
 * clear farewell in the transcript" — the graph only reaches END when the
 * model deliberately calls this, never by guessing intent from text. Call it
 * only once the conversation is genuinely resolved (per the system prompt's
 * checklist for the current phase).
 */
const { z } = require("zod");

const schema = z.object({
  reason: z.string().nullish().describe("Brief note on why the conversation is ending (e.g. 'confirmed and wrapped up')."),
});

async function run() {
  return JSON.stringify({ success: true });
}

module.exports = {
  name: "end_conversation",
  description: "Call this when the conversation is fully resolved and you are ready to say goodbye. This is the ONLY way to end the conversation — do not just stop responding.",
  schema,
  run,
};
