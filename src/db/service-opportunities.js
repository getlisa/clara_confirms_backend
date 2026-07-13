/**
 * Service opportunities routes' DB layer — reads from the standalone
 * `service_opportunities` table, joined with locations/jobs/service_lines
 * for display context. Filterable by location and office (via the
 * location_offices junction), since ServiceTrade itself is fetched account-wide.
 */
const db = require("./index");

async function list(companyId, { locationId, officeId, jobId, status, serviceLineId, city, limit = 50, offset = 0 } = {}) {
  const conditions = ["so.company_id = $1"];
  const values = [companyId];
  let i = 2;

  if (locationId != null) {
    conditions.push(`so.location_id = $${i++}`);
    values.push(locationId);
  }
  if (officeId != null) {
    conditions.push(`EXISTS (SELECT 1 FROM location_offices lo WHERE lo.location_id = so.location_id AND lo.office_id = $${i++})`);
    values.push(officeId);
  }
  if (jobId != null) {
    conditions.push(`so.job_id = $${i++}`);
    values.push(jobId);
  }
  if (status) {
    conditions.push(`so.status = $${i++}`);
    values.push(status);
  }
  if (serviceLineId != null) {
    conditions.push(`so.service_line_id = $${i++}`);
    values.push(serviceLineId);
  }
  if (city) {
    conditions.push(`l.city = $${i++}`);
    values.push(city);
  }

  // city filters via the locations join, so both the page query and the count
  // query need it — count without the join would ignore the city condition.
  const where = conditions.join(" AND ");
  const [rowsResult, countResult] = await Promise.all([
    db.query(
      `SELECT so.*, l.name AS location_name, j.status AS job_status, sl.name AS service_line_name
       FROM service_opportunities so
       LEFT JOIN locations l     ON l.id = so.location_id
       LEFT JOIN jobs j          ON j.id = so.job_id
       LEFT JOIN service_lines sl ON sl.id = so.service_line_id
       WHERE ${where}
       ORDER BY so.window_start ASC NULLS LAST, so.created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    ),
    db.query(
      `SELECT COUNT(*)::int AS n
       FROM service_opportunities so
       LEFT JOIN locations l ON l.id = so.location_id
       WHERE ${where}`,
      values
    ),
  ]);
  return { rows: rowsResult.rows, total: countResult.rows[0].n };
}

/** Distinct service lines available for this company, for filter dropdowns */
async function listServiceLines(companyId) {
  const result = await db.query(
    `SELECT id, name FROM service_lines WHERE company_id = $1 ORDER BY name ASC NULLS LAST`,
    [companyId]
  );
  return result.rows;
}

async function getById(id, companyId) {
  const result = await db.query(
    `SELECT so.*, l.name AS location_name, j.status AS job_status, sl.name AS service_line_name
     FROM service_opportunities so
     LEFT JOIN locations l     ON l.id = so.location_id
     LEFT JOIN jobs j          ON j.id = so.job_id
     LEFT JOIN service_lines sl ON sl.id = so.service_line_id
     WHERE so.id = $1 AND so.company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) return null;
  const opportunity = result.rows[0];

  const techsResult = await db.query(
    `SELECT t.id, t.first_name, t.last_name, t.phone
     FROM service_opportunity_preferred_techs pt JOIN technicians t ON t.id = pt.technician_id
     WHERE pt.service_opportunity_id = $1`,
    [id]
  );
  opportunity.preferred_technicians = techsResult.rows;

  return opportunity;
}

module.exports = { list, getById, listServiceLines };
