/**
 * Company routes - current user's company (tenant)
 * GET /company - get current company
 * PATCH /company - update company (name, default_timezone)
 */

const express = require("express");
const db = require("../db");
const { authenticate, getCompanyId } = require("../auth");
const logger = require("../utils/logger");

const router = express.Router();

router.use(authenticate);

/**
 * GET /company
 * Returns the authenticated user's company.
 */
router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) {
      return res.status(403).json({ error: "Company context required" });
    }
    const result = await db.query(
      `SELECT id, name, default_timezone, address_line1, city, state, zipcode, country,
              created_at, updated_at FROM companies WHERE id = $1`,
      [companyId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Company not found" });
    }
    const row = result.rows[0];
    return res.json({
      company: {
        id: String(row.id),
        name: row.name,
        default_timezone: row.default_timezone || "America/New_York",
        address_line1: row.address_line1 ?? "",
        city: row.city ?? "",
        state: row.state ?? "",
        zipcode: row.zipcode ?? "",
        country: row.country ?? "",
      },
    });
  } catch (err) {
    logger.error("GET /company failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load company" });
  }
});

/**
 * PATCH /company
 * Body: { name?, default_timezone?, address_line1?, city?, state?, zipcode?, country? }
 */
router.patch("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) {
      return res.status(403).json({ error: "Company context required" });
    }
    const {
      name,
      default_timezone: defaultTimezone,
      address_line1,
      city,
      state,
      zipcode,
      country,
    } = req.body;
    const updates = [];
    const values = [];
    let i = 1;
    if (name !== undefined) {
      updates.push(`name = $${i++}`);
      values.push(String(name).trim());
    }
    if (defaultTimezone !== undefined) {
      updates.push(`default_timezone = $${i++}`);
      values.push(String(defaultTimezone).trim());
    }
    if (address_line1 !== undefined) {
      updates.push(`address_line1 = $${i++}`);
      values.push(String(address_line1).trim() || null);
    }
    if (city !== undefined) {
      updates.push(`city = $${i++}`);
      values.push(String(city).trim() || null);
    }
    if (state !== undefined) {
      updates.push(`state = $${i++}`);
      values.push(String(state).trim() || null);
    }
    if (zipcode !== undefined) {
      updates.push(`zipcode = $${i++}`);
      values.push(String(zipcode).trim() || null);
    }
    if (country !== undefined) {
      updates.push(`country = $${i++}`);
      values.push(String(country).trim() || null);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }
    values.push(companyId);
    await db.query(
      `UPDATE companies SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${i}`,
      values
    );
    const result = await db.query(
      `SELECT id, name, default_timezone, address_line1, city, state, zipcode, country
       FROM companies WHERE id = $1`,
      [companyId]
    );
    const row = result.rows[0];
    return res.json({
      company: {
        id: String(row.id),
        name: row.name,
        default_timezone: row.default_timezone || "America/New_York",
        address_line1: row.address_line1 ?? "",
        city: row.city ?? "",
        state: row.state ?? "",
        zipcode: row.zipcode ?? "",
        country: row.country ?? "",
      },
    });
  } catch (err) {
    logger.error("PATCH /company failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update company" });
  }
});

module.exports = router;
