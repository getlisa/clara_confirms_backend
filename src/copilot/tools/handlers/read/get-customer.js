const { z } = require("zod");
const customersDb = require("../../../../db/customers");

const schema = z.object({
  customer_id: z.union([z.string(), z.number()]).describe("The customer's id (use find_customer first to resolve a name)."),
});

async function run({ customer_id }, config) {
  const companyId = config?.configurable?.ctx?.companyId;
  const customer = await customersDb.getById(customer_id, companyId);
  if (!customer) return JSON.stringify({ status: "not_found", customer_id });
  return JSON.stringify({ status: "ok", customer });
}

module.exports = {
  name: "get_customer",
  description:
    "Get a customer's full profile: contact details, their jobs (each with its latest appointment and confirmation status), and their quotations. Resolve the name with find_customer first.",
  isWrite: false,
  schema,
  run,
};
