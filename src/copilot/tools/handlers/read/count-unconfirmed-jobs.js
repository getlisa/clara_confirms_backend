const { z } = require("zod");
const db = require("../../../../db");

const schema = z.object({}).describe("No parameters.");

async function run(_args, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  // A job is "unconfirmed" when it's scheduled but has no appointment the
  // customer has confirmed. Mirrors the dashboard `jobs.unconfirmed` metric.
  const r = await db.query(
    `SELECT
       COUNT(*)::int                       AS unconfirmed_jobs,
       COUNT(DISTINCT customer_id)::int    AS customers_with_unconfirmed_jobs
     FROM jobs
     WHERE company_id = $1
       AND status = 'scheduled'
       AND NOT EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.job_id = jobs.id AND a.customer_confirmed = true
       )`,
    [companyId]
  );
  return JSON.stringify(r.rows[0]);
}

module.exports = {
  name: "count_unconfirmed_jobs",
  description:
    "Count scheduled jobs that have no customer-confirmed appointment, and how many distinct customers those belong to. Use for questions like 'how many unconfirmed jobs are there?' or 'how many customers have unconfirmed jobs?'.",
  isWrite: false,
  schema,
  run,
};
