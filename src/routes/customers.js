/**
 * Customers routes — reads from the standalone `customers` table.
 * ServiceTrade raw data stays in servicetrade_* tables (untouched).
 *
 * GET  /customers              — list customers
 * GET  /customers/:id          — customer detail with jobs + quotations
 * POST /customers              — create customer
 * PATCH /customers/:id         — update customer
 */

const express = require("express");
const customersDb = require("../db/customers");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");
const { getCompanyTimezone, localizeFields, localizeRows } = require("../utils/timezone");

const router = express.Router();
router.use(authenticate);

const CUSTOMER_TZ_FIELDS = ["created_at", "updated_at"];
// scheduled_date/valid_until are DATE-only columns — never passed through these.
const CUSTOMER_JOB_TZ_FIELDS  = ["scheduled_window_start", "scheduled_window_end", "created_at", "updated_at", "scheduled_start", "scheduled_end"];
const CUSTOMER_QUOTE_TZ_FIELDS = ["created_at"];

function localizeCustomer(customer, tz) {
  if (!customer) return customer;
  const out = localizeFields(customer, tz, CUSTOMER_TZ_FIELDS);
  if (Array.isArray(customer.jobs))       out.jobs       = localizeRows(customer.jobs, tz, CUSTOMER_JOB_TZ_FIELDS);
  if (Array.isArray(customer.quotations)) out.quotations = localizeRows(customer.quotations, tz, CUSTOMER_QUOTE_TZ_FIELDS);
  return out;
}

/**
 * GET /customers
 * Query params: search, is_active (true/false), limit, offset
 */
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { search, is_active, limit, offset } = req.query;
    const limitNum = limit ? Math.min(Number(limit), 200) : 50;
    const offsetNum = offset ? Number(offset) : 0;

    const { rows: customers, total } = await customersDb.list(companyId, {
      search:   search || undefined,
      isActive: is_active === "true" ? true : is_active === "false" ? false : undefined,
      limit:    limitNum,
      offset:   offsetNum,
    });

    const tz = await getCompanyTimezone(companyId);
    return res.json({
      customers: localizeRows(customers, tz, CUSTOMER_TZ_FIELDS),
      pagination: { total, limit: limitNum, offset: offsetNum, totalPages: Math.max(Math.ceil(total / limitNum), 1) },
    });
  } catch (err) {
    logger.error("GET /customers failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load customers" });
  }
});

/**
 * GET /customers/:id
 * Returns customer + all their jobs (with latest appointment) + quotations.
 */
router.get("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const customer = await customersDb.getById(Number(req.params.id), companyId);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const tz = await getCompanyTimezone(companyId);
    return res.json({ customer: localizeCustomer(customer, tz) });
  } catch (err) {
    logger.error("GET /customers/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load customer" });
  }
});

/**
 * POST /customers
 * Body: { phone (required), first_name?, last_name?, full_name?, email?,
 *         address_line1?, city?, state?, zipcode?, country?,
 *         source?, additional_information? }
 */
router.post("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { phone } = req.body;
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ error: "phone is required" });
    }

    const customer = await customersDb.create(companyId, req.body);
    const tz = await getCompanyTimezone(companyId);
    return res.status(201).json({ customer: localizeFields(customer, tz, CUSTOMER_TZ_FIELDS) });
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "A customer with this phone number already exists" });
    }
    logger.error("POST /customers failed", { error: err.message });
    return res.status(500).json({ error: "Failed to create customer" });
  }
});

/**
 * PATCH /customers/:id
 * Body: any subset of customer fields
 */
router.patch("/:id", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    if (Object.keys(req.body).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const customer = await customersDb.update(Number(req.params.id), companyId, req.body);
    if (!customer) return res.status(404).json({ error: "Customer not found" });

    const tz = await getCompanyTimezone(companyId);
    return res.json({ customer: localizeFields(customer, tz, CUSTOMER_TZ_FIELDS) });
  } catch (err) {
    logger.error("PATCH /customers/:id failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update customer" });
  }
});

module.exports = router;
