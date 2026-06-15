const { z } = require("zod");
const analytics = require("../../../../services/analytics");

const schema = z.object({
  period: z
    .enum(["today", "week", "month", "all"])
    .nullish()
    .describe("Time window for the summary. Defaults to 'week'."),
});

async function run({ period }, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  const stats = await analytics.getStats(companyId, period);
  return JSON.stringify(stats);
}

module.exports = {
  name: "analytics_summary",
  description:
    "Get an aggregate analytics summary for the company over a time period: call outcomes & sentiment, job statuses (incl. unconfirmed & due-soon), to-do counts, the scheduled-call queue, quotation funnel, and customer counts. Use for broad 'how are we doing' / breakdown / rate questions.",
  isWrite: false,
  schema,
  run,
};
