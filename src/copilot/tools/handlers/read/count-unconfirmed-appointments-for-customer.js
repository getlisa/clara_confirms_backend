const { z } = require("zod");
const db = require("../../../../db");

const schema = z.object({
  customer_id: z
    .union([z.string(), z.number()])
    .describe("The customer's id (obtain it from the find_customer tool first)."),
});

async function run({ customer_id }, config) {
  const companyId = config?.configurable?.ctx?.companyId;

  // Verify the customer belongs to this company (tenant isolation).
  const cust = await db.query(
    `SELECT id, full_name FROM customers WHERE id = $1 AND company_id = $2`,
    [customer_id, companyId]
  );
  if (cust.rows.length === 0) {
    return JSON.stringify({ status: "not_found", customer_id });
  }

  const r = await db.query(
    `SELECT a.id, a.scheduled_start, a.status, a.customer_confirmed, j.title AS job_title
     FROM appointments a
     JOIN jobs j ON j.id = a.job_id
     WHERE j.company_id = $1
       AND j.customer_id = $2
       AND a.status NOT IN ('cancelled', 'completed', 'no_show')
       AND a.customer_confirmed IS NOT TRUE
     ORDER BY a.scheduled_start ASC NULLS LAST`,
    [companyId, customer_id]
  );

  return JSON.stringify({
    status: "ok",
    customer: { id: cust.rows[0].id, name: cust.rows[0].full_name },
    unconfirmed_count: r.rows.length,
    appointments: r.rows.map((x) => ({
      appointment_id: x.id,
      job_title: x.job_title,
      scheduled_start: x.scheduled_start,
      status: x.status,
    })),
  });
}

module.exports = {
  name: "count_unconfirmed_appointments_for_customer",
  description:
    "Count (and list) the active appointments a specific customer has NOT yet confirmed. Requires a customer_id — resolve the name with find_customer first.",
  isWrite: false,
  schema,
  run,
};
