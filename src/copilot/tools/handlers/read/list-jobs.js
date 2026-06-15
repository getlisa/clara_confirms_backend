const { z } = require("zod");
const jobsDb = require("../../../../db/jobs");

const schema = z.object({
  status: z
    .enum(["open", "scheduled", "rescheduled", "confirmed", "in_progress", "completed", "cancelled"])
    .nullish()
    .describe("Optional job status filter."),
  customer_id: z.union([z.string(), z.number()]).nullish().describe("Optional: only this customer's jobs."),
  search: z.string().nullish().describe("Optional free-text search on job title."),
  due_soon_days: z.number().int().min(1).max(60).nullish().describe("Optional: jobs scheduled within the next N days."),
  limit: z.number().int().min(1).max(50).nullish().describe("Max jobs to return (default 20)."),
});

async function run({ status, customer_id, search, due_soon_days, limit }, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  const rows = await jobsDb.listJobs(companyId, {
    status: status || undefined,
    customerId: customer_id || undefined,
    search: search || undefined,
    dueSoonDays: due_soon_days ?? undefined,
    limit: limit ?? 20,
  });
  return JSON.stringify({
    count: rows.length,
    jobs: rows.map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      job_type: j.job_type,
      scheduled_date: j.scheduled_date,
      customer: j.customer_name ?? null,
      technician: j.technician_name ?? null,
    })),
  });
}

module.exports = {
  name: "list_jobs",
  description:
    "List jobs for the company, optionally filtered by status, customer, free-text title search, or due-soon window. Returns a compact row per job.",
  isWrite: false,
  schema,
  run,
};
