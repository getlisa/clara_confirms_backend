const db = require("./index");

function rowToObject(row) {
  return {
    id:                     row.id,
    company_id:             row.company_id,
    first_name:             row.first_name ?? null,
    last_name:              row.last_name ?? null,
    full_name:              row.full_name ?? null,
    email:                  row.email ?? null,
    phone:                  row.phone,
    alternate_phone:        row.alternate_phone ?? null,
    address_line1:          row.address_line1 ?? null,
    city:                   row.city ?? null,
    state:                  row.state ?? null,
    zipcode:                row.zipcode ?? null,
    country:                row.country ?? "US",
    is_active:              row.is_active,
    source:                 row.source ?? null,
    is_voice:               row.is_voice,
    is_sms:                 row.is_sms,
    is_email:               row.is_email,
    confirmation_include_customer: row.confirmation_include_customer,
    confirmation_contact_ids:      row.confirmation_contact_ids ?? [],
    additional_information: row.additional_information ?? {},
    created_at:             row.created_at,
    updated_at:             row.updated_at,
  };
}

async function list(companyId, { search, isActive, limit = 50, offset = 0 } = {}) {
  const conditions = ["company_id = $1"];
  const values = [companyId];
  let i = 2;

  if (typeof isActive === "boolean") {
    conditions.push(`is_active = $${i++}`);
    values.push(isActive);
  }
  if (search) {
    conditions.push(
      `(full_name ILIKE $${i} OR phone ILIKE $${i} OR email ILIKE $${i})`
    );
    values.push(`%${search}%`);
    i++;
  }

  const where = conditions.join(" AND ");
  const [rowsResult, countResult] = await Promise.all([
    db.query(
      `SELECT * FROM customers
       WHERE ${where}
       ORDER BY full_name ASC NULLS LAST, created_at DESC
       LIMIT $${i} OFFSET $${i + 1}`,
      [...values, limit, offset]
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM customers WHERE ${where}`, values),
  ]);
  return { rows: rowsResult.rows.map(rowToObject), total: countResult.rows[0].n };
}

async function getById(id, companyId) {
  const result = await db.query(
    `SELECT * FROM customers WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!result.rows[0]) return null;
  const customer = rowToObject(result.rows[0]);

  // Attach jobs with their latest appointment
  const jobsResult = await db.query(
    `SELECT j.*,
            t.first_name || ' ' || t.last_name AS technician_name,
            t.phone AS technician_phone,
            a.id AS appointment_id,
            a.scheduled_start, a.scheduled_end,
            a.status AS appointment_status,
            a.customer_confirmed, a.technician_confirmed
     FROM jobs j
     LEFT JOIN technicians t ON t.id = j.technician_id
     LEFT JOIN LATERAL (
       SELECT * FROM appointments ap
       WHERE ap.job_id = j.id
       ORDER BY ap.created_at DESC LIMIT 1
     ) a ON true
     WHERE j.customer_id = $1
     ORDER BY j.created_at DESC`,
    [id]
  );
  customer.jobs = jobsResult.rows;

  // Attach quotations — job_id included so UI can link quote → job directly
  const quotationsResult = await db.query(
    `SELECT id, job_id, quote_number, title, status, total_amount, currency, valid_until, created_at
     FROM quotations WHERE customer_id = $1 ORDER BY created_at DESC`,
    [id]
  );
  customer.quotations = quotationsResult.rows;

  return customer;
}

async function create(companyId, fields) {
  const {
    first_name, last_name, full_name, email, phone, alternate_phone,
    address_line1, city, state, zipcode, country,
    source, additional_information,
  } = fields;

  const result = await db.query(
    `INSERT INTO customers
       (company_id, first_name, last_name, full_name, email, phone, alternate_phone,
        address_line1, city, state, zipcode, country, source, additional_information)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      companyId, first_name ?? null, last_name ?? null,
      full_name ?? ([first_name, last_name].filter(Boolean).join(" ") || null),
      email ?? null, phone, alternate_phone ?? null,
      address_line1 ?? null, city ?? null, state ?? null,
      zipcode ?? null, country ?? "US",
      source ?? "manual",
      JSON.stringify(additional_information ?? {}),
    ]
  );
  return rowToObject(result.rows[0]);
}

async function update(id, companyId, fields) {
  const allowed = [
    "first_name", "last_name", "full_name", "email", "phone", "alternate_phone",
    "address_line1", "city", "state", "zipcode", "country", "is_active", "additional_information",
    "is_voice", "is_sms", "is_email",
    "confirmation_include_customer", "confirmation_contact_ids",
  ];
  const provided = Object.keys(fields).filter((k) => allowed.includes(k) && k in fields);
  if (provided.length === 0) return getById(id, companyId);

  const setClauses = provided.map((k, idx) => `${k} = $${idx + 3}`).join(", ");
  const values = [
    id, companyId,
    ...provided.map((k) =>
      k === "additional_information" ? JSON.stringify(fields[k]) : fields[k]
    ),
  ];

  const result = await db.query(
    `UPDATE customers SET ${setClauses}, updated_at = NOW()
     WHERE id = $1 AND company_id = $2
     RETURNING *`,
    values
  );
  return result.rows[0] ? rowToObject(result.rows[0]) : null;
}

/**
 * Contacts linked to this customer via `contact_companies` — the checklist
 * of people who could additionally receive this customer's confirmations.
 * Same join `getJobContacts` (src/db/jobs.js) uses, without the job-scoped
 * primary-contact/location union — there's no job in play here, just "every
 * contact tied to this customer."
 */
async function getConfirmationContacts(customerId, companyId) {
  const { rows } = await db.query(
    `SELECT c.id, c.first_name, c.last_name, c.phone, c.mobile,
            c.alternate_phone, c.email, c.contact_role
       FROM contacts c
       JOIN contact_companies cc ON cc.contact_id = c.id
      WHERE c.company_id = $1 AND cc.customer_id = $2
      ORDER BY c.last_name NULLS LAST, c.first_name NULLS LAST`,
    [companyId, customerId]
  );
  return rows.map((c) => ({
    id: c.id,
    name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null,
    first_name: c.first_name ?? null,
    last_name: c.last_name ?? null,
    phone: c.phone ?? null,
    mobile: c.mobile ?? null,
    alternate_phone: c.alternate_phone ?? null,
    email: c.email ?? null,
    contact_role: c.contact_role ?? null,
  }));
}

/** Every id in `contactIds` that's actually linked to this customer via contact_companies. */
async function getLinkedContactIds(customerId, companyId, contactIds) {
  if (!contactIds.length) return [];
  const { rows } = await db.query(
    `SELECT c.id
       FROM contacts c
       JOIN contact_companies cc ON cc.contact_id = c.id
      WHERE c.company_id = $1 AND cc.customer_id = $2 AND c.id = ANY($3::int[])`,
    [companyId, customerId, contactIds]
  );
  return rows.map((r) => r.id);
}

module.exports = { list, getById, create, update, getConfirmationContacts, getLinkedContactIds };
