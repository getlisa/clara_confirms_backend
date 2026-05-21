const express = require("express");
const db = require("../db");
const { authenticate, getCompanyId } = require("../auth");
const { syncFlowForCompany } = require("../services/retell-flow");
const { getAreaCodesForState, getPrimaryAreaCode, suggestAreaCode } = require("../utils/area-code");
const logger = require("../utils/logger");

const router = express.Router();
router.use(authenticate);

// ── GET /company ───────────────────────────────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const result = await db.query(
      `SELECT id, name, default_timezone, address_line1, city, state, zipcode, country,
              office_area_code, retell_phone_number, retell_agent_id, retell_conversation_flow_id,
              created_at, updated_at FROM companies WHERE id = $1`,
      [companyId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Company not found" });

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
        office_area_code: row.office_area_code ?? null,
        suggested_area_codes: row.state ? getAreaCodesForState(row.state) : [],
        retell_provisioned: !!(row.retell_agent_id && row.retell_conversation_flow_id),
        phone_number_set: !!row.retell_phone_number,
      },
    });
  } catch (err) {
    logger.error("GET /company failed", { error: err.message });
    return res.status(500).json({ error: "Failed to load company" });
  }
});

// ── GET /company/area-codes ────────────────────────────────────────────────────

/**
 * GET /company/area-codes?state=CA
 * Returns available area codes for a given US state/province.
 * Used by the UI to populate a dropdown when the admin selects their state.
 */
router.get("/area-codes", (req, res) => {
  const { state } = req.query;
  if (!state) return res.status(400).json({ error: "state query param is required" });

  const codes = getAreaCodesForState(state);
  if (codes.length === 0) {
    return res.status(404).json({ error: `No area codes found for state: ${state}` });
  }
  return res.json({
    state: state.trim().toUpperCase(),
    primary: codes[0],
    area_codes: codes,
  });
});

// ── PATCH /company ─────────────────────────────────────────────────────────────

/**
 * PATCH /company
 * Body: { name?, default_timezone?, address_line1?, city?, state?, zipcode?, country?, office_area_code? }
 *
 * When state is updated and office_area_code is not explicitly provided,
 * the primary area code for that state is auto-set.
 */
router.patch("/", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const {
      name,
      default_timezone: defaultTimezone,
      address_line1,
      city,
      state,
      zipcode,
      country,
      office_area_code,
    } = req.body;

    const updates = [];
    const values = [];
    let i = 1;

    if (name !== undefined)           { updates.push(`name = $${i++}`);             values.push(String(name).trim()); }
    if (defaultTimezone !== undefined){ updates.push(`default_timezone = $${i++}`); values.push(String(defaultTimezone).trim()); }
    if (address_line1 !== undefined)  { updates.push(`address_line1 = $${i++}`);    values.push(String(address_line1).trim() || null); }
    if (city !== undefined)           { updates.push(`city = $${i++}`);             values.push(String(city).trim() || null); }
    if (state !== undefined)          { updates.push(`state = $${i++}`);            values.push(String(state).trim() || null); }
    if (zipcode !== undefined)        { updates.push(`zipcode = $${i++}`);          values.push(String(zipcode).trim() || null); }
    if (country !== undefined)        { updates.push(`country = $${i++}`);          values.push(String(country).trim() || null); }

    // office_area_code: explicit value wins; if state changed and no code given, auto-derive
    if (office_area_code !== undefined) {
      const code = parseInt(office_area_code, 10);
      if (isNaN(code) || code < 200 || code > 999) {
        return res.status(400).json({ error: "office_area_code must be a valid 3-digit area code" });
      }
      updates.push(`office_area_code = $${i++}`);
      values.push(code);
    } else if (state !== undefined && state) {
      // Auto-derive primary area code for the new state
      const derived = getPrimaryAreaCode(state);
      if (derived) {
        updates.push(`office_area_code = $${i++}`);
        values.push(derived);
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

    values.push(companyId);
    await db.query(
      `UPDATE companies SET ${updates.join(", ")}, updated_at = NOW() WHERE id = $${i}`,
      values
    );

    const result = await db.query(
      `SELECT id, name, default_timezone, address_line1, city, state, zipcode, country,
              office_area_code FROM companies WHERE id = $1`,
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
        office_area_code: row.office_area_code ?? null,
        suggested_area_codes: row.state ? getAreaCodesForState(row.state) : [],
      },
    });
  } catch (err) {
    logger.error("PATCH /company failed", { error: err.message });
    return res.status(500).json({ error: "Failed to update company" });
  }
});

// ── PATCH /company/phone-number ───────────────────────────────────────────────

router.patch("/phone-number", async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(403).json({ error: "Company context required" });

    const { retell_phone_number } = req.body;
    if (!retell_phone_number || !String(retell_phone_number).trim()) {
      return res.status(400).json({ error: "retell_phone_number is required" });
    }

    const phone = String(retell_phone_number).trim();
    await db.query(
      `UPDATE companies SET retell_phone_number = $1, updated_at = NOW() WHERE id = $2`,
      [phone, companyId]
    );

    syncFlowForCompany(companyId).catch((err) =>
      logger.error("Retell flow sync failed after phone number update", { companyId, error: err.message })
    );

    return res.json({ message: "Phone number saved", phone_number_set: true });
  } catch (err) {
    logger.error("PATCH /company/phone-number failed", { error: err.message });
    return res.status(500).json({ error: "Failed to save phone number" });
  }
});

module.exports = router;
