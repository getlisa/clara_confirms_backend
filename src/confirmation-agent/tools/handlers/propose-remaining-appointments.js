/**
 * The agent's own proactive "want to confirm the rest too?" turn — a real
 * LLM call (not a synthetic card-route turn), so the agent's memory is
 * genuinely enriched and the question shows up as a normal conversation-log
 * entry, not a silent UI-only prompt.
 *
 * Only ever bound to the model on the ONE turn triggered right after a
 * card-driven confirm/reschedule leaves other appointments unconfirmed — see
 * graph/build.js's isProposeRemainingTurn (the sole gate; this tool is never
 * offered any other turn) and prompt.js's PROPOSE_REMAINING section.
 *
 * Structured JSON instead of parsed prose so the frontend can reliably render
 * cards from the answer. `appointment_ids` is cross-checked against the real
 * still-unconfirmed list rather than trusted blindly — a hallucinated id here
 * would otherwise silently mis-render a card for an appointment that isn't
 * actually pending.
 */
const { z } = require("zod");
const { buildAppointmentCards } = require("../../appointment-card");
const { buildJobConfirmationContext } = require("../../../services/job-confirmation-context");

const schema = z.object({
  message: z.string().describe("The natural-language message to show the customer, asking if they'd like to confirm the other still-unconfirmed appointments too."),
  appointment_ids: z.array(z.union([z.string(), z.number()])).describe("The appointment_id of every other still-unconfirmed upcoming appointment being asked about."),
});

async function run({ message, appointment_ids }, config) {
  const { companyId, jobId } = config?.configurable?.ctx || {};
  const ctx = await buildJobConfirmationContext(companyId, jobId);
  if (!ctx.ok) return JSON.stringify({ success: false, error: ctx.error });

  const wanted = new Set((appointment_ids || []).map((v) => String(v)));
  const appointments = buildAppointmentCards(ctx).filter((c) => wanted.has(String(c.appointment_id)) && c.status === "not_confirmed");

  return JSON.stringify({ success: true, message, appointments });
}

module.exports = {
  name: "propose_remaining_appointments",
  description: "Ask the customer whether they'd like to confirm the other still-unconfirmed upcoming appointments on this job. Only ever called when explicitly instructed to ask this, right now, as the entire turn.",
  schema,
  run,
};
