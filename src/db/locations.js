/**
 * Locations routes' DB layer — reads from the standalone `locations` table.
 * ServiceTrade raw data stays in servicetrade_* tables (untouched).
 */
const db = require("./index");

async function list(companyId, { search, customerId, isActive, limit = 50, offset = 0 } = {}) {
  const conditions = ["company_id = $1"];
  const values = [companyId];
  let i = 2;

  if (customerId != null) {
    conditions.push(`customer_id = $${i++}`);
    values.push(customerId);
  }
  if (typeof isActive === "boolean") {
    conditions.push(`is_active = $${i++}`);
    values.push(isActive);
  }
  if (search) {
    conditions.push(`(name ILIKE $${i} OR address_line1 ILIKE $${i} OR city ILIKE $${i})`);
    values.push(`%${search}%`);
    i++;
  }

  const where = conditions.join(" AND ");
  const [rowsResult, countResult] = await Promise.all([
    db.query(
      `SELECT * FROM locations
       WHERE ${where}
       ORDER BY name ASC NULLS LAST, created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM locations WHERE ${where}`, values),
  ]);
  return { rows: rowsResult.rows, total: countResult.rows[0].n };
}

async function getById(id, companyId) {
  const result = await db.query(`SELECT * FROM locations WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!result.rows[0]) return null;
  const location = result.rows[0];

  if (location.primary_contact_id) {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, phone, mobile, alternate_phone, email, type
       FROM contacts WHERE id = $1`,
      [location.primary_contact_id]
    );
    location.primary_contact = rows[0] || null;
  } else {
    location.primary_contact = null;
  }

  const officesResult = await db.query(
    `SELECT o.id, o.name, o.phone, o.email
     FROM location_offices lo JOIN offices o ON o.id = lo.office_id
     WHERE lo.location_id = $1`,
    [id]
  );
  location.offices = officesResult.rows;

  const tagsResult = await db.query(
    `SELECT t.id, t.name
     FROM location_tags lt JOIN tags t ON t.id = lt.tag_id
     WHERE lt.location_id = $1`,
    [id]
  );
  location.tags = tagsResult.rows;

  return location;
}

module.exports = { list, getById };
