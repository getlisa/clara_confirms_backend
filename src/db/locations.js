/**
 * Locations routes' DB layer — reads from the standalone `locations` table.
 * ServiceTrade raw data stays in servicetrade_* tables (untouched).
 */
const db = require("./index");

/**
 * Fold the LATERAL aggregate into the shape the API returns. Always present,
 * with zeroes rather than null, so the UI can render a badge unconditionally
 * instead of branching on whether the key exists.
 */
function withDeficiencySummary(row) {
  const { open_count, by_status, ...rest } = row;
  return {
    ...rest,
    deficiency_summary: {
      open: open_count ?? 0,
      by_status: by_status || {},
    },
  };
}

/**
 * A location's deficiencies. `openOnly` defaults TRUE — the resolved ones are
 * history and every caller so far wants what is outstanding.
 */
async function listDeficiencies(companyId, locationId, { openOnly = true, status = null, limit = 100, offset = 0 } = {}) {
  const conditions = ["company_id = $1", "location_id = $2"];
  const values = [companyId, locationId];
  let i = 3;
  if (openOnly) conditions.push("is_resolved = false");
  if (status) { conditions.push(`status = $${i++}`); values.push(status); }
  const where = conditions.join(" AND ");

  const [rows, count] = await Promise.all([
    db.query(
      `SELECT id, ref_number, name, description, status, is_resolved,
              opened_at, resolved_at, source, external_ref, additional_information,
              service_line_id, external_parent_ref, detail
         FROM deficiencies
        WHERE ${where}
        ORDER BY opened_at DESC NULLS LAST, id DESC
        LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM deficiencies WHERE ${where}`, values),
  ]);
  return { rows: rows.rows.map(presentDeficiency), total: count.rows[0].n };
}

/**
 * The API shape. `detail` is passed through VERBATIM and deliberately not
 * flattened: across the live tenant's 436 open rows there are six different
 * `asset_details` key sets with nothing in common beyond `System/Asset Type`
 * (Asset carries Manufacturer/Model, Equipment carries Equipment type,
 * Inspection external form carries only Display Name, and so on). Any
 * flattening would fit one shape and misrepresent the other five, so the
 * frontend interprets it — see docs/deficiencies-frontend.md.
 */
function presentDeficiency(row) {
  const extra = row.additional_information || {};
  return {
    id: row.id,
    ref_number: row.ref_number,
    name: row.name,
    description: row.description,
    // Null on ~99% of InspectPoint rows — the UI must not depend on it.
    status: row.status,
    is_resolved: row.is_resolved,
    opened_at: row.opened_at,
    resolved_at: row.resolved_at,
    source: row.source,
    external_ref: row.external_ref,
    asset_type: extra.asset_type ?? null,
    resolution_status: extra.resolution_status ?? null,
    // A deficiency IS a service line now; this is its catalog row.
    service_line_id: row.service_line_id ?? null,
    // The CRM's inspection id. There is NO platform job behind it — those
    // inspections are completed and deliberately outside `jobs` — so do not
    // build a job link from it.
    inspection_ref: row.external_parent_ref ?? null,
    detail: row.detail || {},
  };
}

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
      // deficiency_summary is a LATERAL aggregate, not a join+GROUP BY: the
       // list is paged, and grouping the whole locations table to return 50
       // rows scales with the company's deficiency count rather than the page
       // size. The partial index from migration 110
       // (company_id, location_id) WHERE is_resolved = false serves it.
       `SELECT l.*, d.open_count, d.by_status
          FROM locations l
          LEFT JOIN LATERAL (
            SELECT COALESCE(sum(n), 0)::int AS open_count,
                   jsonb_object_agg(COALESCE(status, 'unspecified'), n) AS by_status
              FROM (
                SELECT status, count(*)::int AS n
                  FROM deficiencies
                 WHERE company_id = l.company_id AND location_id = l.id AND is_resolved = false
                 GROUP BY status
              ) t
          ) d ON true
       WHERE ${where.replace(/\bcompany_id\b/g, "l.company_id")
                    .replace(/\bcustomer_id\b/g, "l.customer_id")
                    .replace(/\bis_active\b/g, "l.is_active")
                    .replace(/\bname\b/g, "l.name")
                    .replace(/\baddress_line1\b/g, "l.address_line1")
                    .replace(/\bcity\b/g, "l.city")}
       ORDER BY l.name ASC NULLS LAST, l.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM locations WHERE ${where}`, values),
  ]);
  return { rows: rowsResult.rows.map(withDeficiencySummary), total: countResult.rows[0].n };
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

module.exports = { list, getById, listDeficiencies, presentDeficiency, withDeficiencySummary };
