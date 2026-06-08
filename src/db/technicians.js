const db = require("./index");

/**
 * Upsert a technician matched by external_ref + source first, falling back to phone
 * (so manually-added techs get adopted by ServiceTrade when their phones match).
 *
 * Rows with missing phone are inserted with phone=null; warnings on the row
 * should be carried in additional_information.warnings by the caller.
 *
 * @param {object} args
 * @param {number} args.companyId
 * @param {string} args.externalRef
 * @param {string} args.source
 * @param {string} [args.firstName]
 * @param {string} [args.lastName]
 * @param {string} [args.phone]            — optional; nullable on the platform side
 * @param {string} [args.email]
 * @param {boolean} [args.isActive=true]
 * @param {object} [args.additionalInformation]
 * @returns {Promise<object|null>} the upserted row
 */
async function upsertByExternalRef({
  companyId, externalRef, source,
  firstName, lastName, phone, email,
  isActive = true,
  additionalInformation = {},
}) {

  // 1) Try to match by (company_id, external_ref)
  const byRef = await db.query(
    `SELECT id FROM technicians WHERE company_id = $1 AND external_ref = $2 AND source = $3 LIMIT 1`,
    [companyId, String(externalRef), source]
  );

  if (byRef.rows.length > 0) {
    const id = byRef.rows[0].id;
    const r = await db.query(
      `UPDATE technicians SET
         first_name = $1, last_name = $2, phone = $3, email = $4,
         is_active = $5, additional_information = $6, updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [firstName, lastName, phone, email ?? null, isActive, JSON.stringify(additionalInformation), id]
    );
    return r.rows[0];
  }

  // 2) Fall back to (company_id, phone) — adopt a manually-added row (skip if no phone)
  const byPhone = phone
    ? await db.query(
        `SELECT id, external_ref FROM technicians WHERE company_id = $1 AND phone = $2 LIMIT 1`,
        [companyId, phone]
      )
    : { rows: [] };

  if (byPhone.rows.length > 0) {
    const id = byPhone.rows[0].id;
    const r = await db.query(
      `UPDATE technicians SET
         first_name = $1, last_name = $2, email = $3,
         is_active = $4, external_ref = $5, source = $6,
         additional_information = $7, updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [firstName, lastName, email ?? null, isActive, String(externalRef), source,
       JSON.stringify(additionalInformation), id]
    );
    return r.rows[0];
  }

  // 3) Insert new
  try {
    const r = await db.query(
      `INSERT INTO technicians
         (company_id, first_name, last_name, phone, email, is_active,
          external_ref, source, additional_information)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [companyId, firstName, lastName, phone, email ?? null, isActive,
       String(externalRef), source, JSON.stringify(additionalInformation)]
    );
    return r.rows[0];
  } catch (err) {
    // Race: another transaction inserted the same (phone) or (external_ref) — retry by whichever applies
    if (err.code === "23505") {
      if (phone) {
        const retry = await db.query(
          `UPDATE technicians SET
             first_name = $1, last_name = $2, email = $3,
             is_active = $4, external_ref = $5, source = $6,
             additional_information = $7, updated_at = NOW()
           WHERE company_id = $8 AND phone = $9 RETURNING *`,
          [firstName, lastName, email ?? null, isActive, String(externalRef), source,
           JSON.stringify(additionalInformation), companyId, phone]
        );
        if (retry.rows[0]) return retry.rows[0];
      }
      const retryByRef = await db.query(
        `UPDATE technicians SET
           first_name = $1, last_name = $2, phone = $3, email = $4,
           is_active = $5, additional_information = $6, updated_at = NOW()
         WHERE company_id = $7 AND external_ref = $8 AND source = $9 RETURNING *`,
        [firstName, lastName, phone ?? null, email ?? null, isActive,
         JSON.stringify(additionalInformation), companyId, String(externalRef), source]
      );
      return retryByRef.rows[0] ?? null;
    }
    throw err;
  }
}

async function listByCompany(companyId, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? "SELECT * FROM technicians WHERE company_id = $1 AND is_active = true ORDER BY first_name"
    : "SELECT * FROM technicians WHERE company_id = $1 ORDER BY first_name";
  const r = await db.query(sql, [companyId]);
  return r.rows;
}

module.exports = { upsertByExternalRef, listByCompany };
