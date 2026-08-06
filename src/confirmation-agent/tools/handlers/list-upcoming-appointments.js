/**
 * Page through a job's upcoming appointments when there are too many to list
 * inline in the system prompt (see prompt.js's MAX_INLINE_UPCOMING) — e.g. a
 * recurring-service contract with 20-30 future visits. Re-fetches
 * buildJobConfirmationContext live (same pattern every other tool uses, so
 * this never returns stale data) and slices the already-sorted (earliest
 * first) upcoming list.
 */
const { z } = require("zod");
const { buildJobConfirmationContext } = require("../../../services/job-confirmation-context");
const logger = require("../../../utils/logger");

const schema = z.object({
  offset: z.number().int().min(0).nullish().describe("How many upcoming appointments to skip, starting from the earliest. Defaults to 0."),
  limit: z.number().int().min(1).max(25).nullish().describe("Max appointments to return in this page. Defaults to 10."),
});

async function run({ offset, limit }, config) {
  const { companyId, jobId } = config?.configurable?.ctx || {};
  const start = Number.isInteger(offset) ? offset : 0;
  const count = Number.isInteger(limit) ? limit : 10;

  const ctx = await buildJobConfirmationContext(companyId, jobId);
  if (!ctx.ok) return JSON.stringify({ success: false, error: ctx.error });

  const all = ctx.appointments.upcoming;
  const page = all.slice(start, start + count).map((a) => ({
    appointment_id: a.appointment_id,
    scheduled_start: a.scheduled_start_spoken,
    service_line: a.service_line,
    technician: a.technician,
    customer_confirmed: a.customer_confirmed,
  }));

  logger.info("ConfirmationAgent tool: list_upcoming_appointments", { companyId, jobId, offset: start, limit: count, returned: page.length, total: all.length });

  return JSON.stringify({
    success: true,
    total: all.length,
    offset: start,
    appointments: page,
    has_more: start + page.length < all.length,
  });
}

module.exports = {
  name: "list_upcoming_appointments",
  description: "Look up a page of this job's upcoming appointments when there are more than what's shown in your instructions (e.g. the customer asks about a specific later visit, or wants to review the full schedule). Sorted earliest first.",
  schema,
  run,
};
