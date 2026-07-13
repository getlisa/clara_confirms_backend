/**
 * Service opportunities routes' DB layer — reads from the standalone
 * `service_opportunities` table. Every foreign-key relation (location, job,
 * deficiency, change_order, contract, service_recurrence, service_line) is
 * embedded as a full nested JSON object built inline via jsonb_build_object,
 * not exposed as a bare *_id column — the frontend should never need a
 * second request just to resolve one of these ids. Filterable by location
 * and office (via the location_offices junction), since ServiceTrade itself
 * is fetched account-wide.
 */
const db = require("./index");

const OPPORTUNITY_SELECT = `
  so.id, so.company_id, so.status, so.description,
  so.window_start, so.window_end, so.closed_on,
  so.estimated_price, so.duration, so.preferred_start_time,
  so.budget, so.preferred_vendor, so.asset, so.visibility,
  so.external_ref, so.source, so.additional_information,
  so.created_at, so.updated_at,
  CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', l.id, 'name', l.name,
    'address_line1', l.address_line1, 'city', l.city, 'state', l.state,
    'zipcode', l.zipcode, 'country', l.country,
    'lat', l.lat, 'lon', l.lon, 'phone', l.phone, 'email', l.email,
    'general_manager_name', l.general_manager_name,
    'primary_contact', CASE WHEN c.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', c.id, 'first_name', c.first_name, 'last_name', c.last_name,
      'phone', c.phone, 'mobile', c.mobile, 'alternate_phone', c.alternate_phone,
      'email', c.email, 'type', c.type
    ) END,
    'customer', CASE WHEN cust.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', cust.id, 'full_name', cust.full_name,
      'email', cust.email, 'phone', cust.phone, 'alternate_phone', cust.alternate_phone,
      'address_line1', cust.address_line1, 'city', cust.city, 'state', cust.state,
      'zipcode', cust.zipcode, 'country', cust.country
    ) END
  ) END AS location,
  CASE WHEN j.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', j.id, 'title', j.title, 'status', j.status, 'job_type', j.job_type
  ) END AS job,
  CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', d.id, 'ref_number', d.ref_number, 'name', d.name, 'description', d.description
  ) END AS deficiency,
  CASE WHEN co.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', co.id, 'status', co.status, 'type', co.type, 'reference_number', co.reference_number
  ) END AS change_order,
  CASE WHEN ct.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', ct.id, 'name', ct.name
  ) END AS contract,
  CASE WHEN sr.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', sr.id, 'description', sr.description, 'frequency', sr.frequency,
    'recurrence_interval', sr.recurrence_interval, 'repeat_weekday', sr.repeat_weekday
  ) END AS service_recurrence,
  CASE WHEN sl.id IS NULL THEN NULL ELSE jsonb_build_object(
    'id', sl.id, 'name', sl.name, 'trade', sl.trade, 'abbr', sl.abbr, 'icon', sl.icon
  ) END AS service_line
`;

const OPPORTUNITY_JOINS = `
  LEFT JOIN locations l           ON l.id = so.location_id
  LEFT JOIN contacts c            ON c.id = l.primary_contact_id
  LEFT JOIN customers cust        ON cust.id = l.customer_id
  LEFT JOIN jobs j                ON j.id = so.job_id
  LEFT JOIN deficiencies d        ON d.id = so.deficiency_id
  LEFT JOIN change_orders co      ON co.id = so.change_order_id
  LEFT JOIN contracts ct          ON ct.id = so.contract_id
  LEFT JOIN service_recurrences sr ON sr.id = so.service_recurrence_id
  LEFT JOIN service_lines sl      ON sl.id = so.service_line_id
`;

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
      `SELECT ${OPPORTUNITY_SELECT}
       FROM service_opportunities so
       ${OPPORTUNITY_JOINS}
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
    `SELECT ${OPPORTUNITY_SELECT}
     FROM service_opportunities so
     ${OPPORTUNITY_JOINS}
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

/**
 * Fetch selected opportunities (by id) with the flat fields the scheduling
 * endpoint needs: the grouping key (location_id, customer_id,
 * primary_contact_id, window_start, window_end), the customer's RAW phone
 * (normalized to E.164 by the caller before dialing), and the fields used to
 * render the per-call context block. Only rows belonging to `companyId` are
 * returned (ids from other companies are silently dropped).
 */
async function listByIdsForScheduling(companyId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const result = await db.query(
    `SELECT so.id, so.description, so.status, so.window_start, so.window_end,
            so.estimated_price,
            so.location_id,
            l.name                 AS location_name,
            l.address_line1        AS location_address_line1,
            l.city                 AS location_city,
            l.state                AS location_state,
            l.zipcode              AS location_zipcode,
            l.general_manager_name AS general_manager_name,
            l.customer_id,
            l.primary_contact_id,
            cust.full_name  AS customer_name,
            cust.phone      AS customer_phone,
            pc.first_name   AS primary_contact_first_name,
            pc.last_name    AS primary_contact_last_name,
            sl.name         AS service_line_name,
            sl.trade        AS service_line_trade,
            d.name          AS deficiency_name,
            d.description   AS deficiency_description,
            sr.frequency    AS recurrence_frequency,
            sr.recurrence_interval AS recurrence_interval
     FROM service_opportunities so
     LEFT JOIN locations l           ON l.id = so.location_id
     LEFT JOIN customers cust        ON cust.id = l.customer_id
     LEFT JOIN contacts pc           ON pc.id = l.primary_contact_id
     LEFT JOIN service_lines sl      ON sl.id = so.service_line_id
     LEFT JOIN deficiencies d        ON d.id = so.deficiency_id
     LEFT JOIN service_recurrences sr ON sr.id = so.service_recurrence_id
     WHERE so.company_id = $1 AND so.id = ANY($2::int[])`,
    [companyId, ids]
  );
  return result.rows;
}

/**
 * Mark a service opportunity as booked in the PLATFORM (not ServiceTrade).
 * Sets status='booked' and records booking metadata in additional_information.
 *
 * NOTE: ServiceTrade write-back is intentionally NOT done here yet — this is
 * the seam where a future create-job/appointment call into ServiceTrade will
 * go once that write API is integrated.
 */
async function markBooked(id, companyId, { preferredDate = null, notes = null, retellCallId = null } = {}) {
  const meta = {
    booked_at: new Date().toISOString(),
    source: "agent",
    ...(preferredDate ? { preferred_date: preferredDate } : {}),
    ...(notes ? { notes } : {}),
    ...(retellCallId ? { retell_call_id: retellCallId } : {}),
  };
  const result = await db.query(
    `UPDATE service_opportunities
        SET status = 'booked',
            additional_information = COALESCE(additional_information, '{}'::jsonb)
              || jsonb_build_object('booking', $3::jsonb),
            updated_at = NOW()
      WHERE id = $1 AND company_id = $2
      RETURNING id, status, additional_information`,
    [id, companyId, JSON.stringify(meta)]
  );
  return result.rows[0] || null;
}

module.exports = { list, getById, listServiceLines, listByIdsForScheduling, markBooked };
