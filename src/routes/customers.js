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
 * GET /customers/:id/contacts
 * Confirmation-recipients checklist — every contact linked to this customer
 * via contact_companies, for the "who else should receive this customer's
 * confirmations" picker.
 */
router.get("/:id/contacts", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const contacts = await customersDb.getConfirmationContacts(Number(req.params.id), companyId);
    return res.json({ contacts });
  } catch (err) {
    logger.error("GET /customers/:id/contacts failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load contacts" });
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

    // Channel flags must resolve to at least one true — the DB CHECK
    // (customers_channel_at_least_one, migration 080) would reject this too,
    // but a 400 naming the rule is a lot more actionable than a raw
    // constraint-violation 500. Merge against the current row since a PATCH
    // may set only one flag without knowing the other two.
    const flagFields = ["is_voice", "is_sms", "is_email"];
    if (flagFields.some((k) => k in req.body)) {
      const existing = await customersDb.getById(Number(req.params.id), companyId);
      if (!existing) return res.status(404).json({ error: "Customer not found" });
      const merged = {
        is_voice: "is_voice" in req.body ? !!req.body.is_voice : existing.is_voice,
        is_sms:   "is_sms"   in req.body ? !!req.body.is_sms   : existing.is_sms,
        is_email: "is_email" in req.body ? !!req.body.is_email : existing.is_email,
      };
      if (!merged.is_voice && !merged.is_sms && !merged.is_email) {
        return res.status(400).json({ error: "At least one of is_voice, is_sms, is_email must be true — a customer needs at least one contact channel." });
      }
    }

    // Confirmation recipients: same merge-and-validate shape as the channel
    // flags above — reject a state where nobody would receive anything
    // (customer excluded AND no extra contacts), and verify every referenced
    // contact actually belongs to this customer (contact_companies) rather
    // than silently dropping a bad id, which would make the saved array
    // mysteriously not match what the frontend's checklist showed.
    const recipientFields = ["confirmation_include_customer", "confirmation_contact_ids"];
    if (recipientFields.some((k) => k in req.body)) {
      const existing = await customersDb.getById(Number(req.params.id), companyId);
      if (!existing) return res.status(404).json({ error: "Customer not found" });

      const includeCustomer = "confirmation_include_customer" in req.body
        ? !!req.body.confirmation_include_customer
        : existing.confirmation_include_customer;
      const contactIds = "confirmation_contact_ids" in req.body
        ? req.body.confirmation_contact_ids
        : existing.confirmation_contact_ids;

      if (!Array.isArray(contactIds) || !contactIds.every((n) => Number.isInteger(n))) {
        return res.status(400).json({ error: "confirmation_contact_ids must be an array of integers" });
      }
      if (!includeCustomer && contactIds.length === 0) {
        return res.status(400).json({ error: "At least one confirmation recipient is required — include the customer or select at least one contact." });
      }
      if (contactIds.length) {
        const linked = await customersDb.getLinkedContactIds(Number(req.params.id), companyId, contactIds);
        const linkedSet = new Set(linked);
        const invalid = contactIds.filter((id) => !linkedSet.has(id));
        if (invalid.length) {
          return res.status(400).json({ error: `These contact ids are not linked to this customer: ${invalid.join(", ")}` });
        }
      }
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
