const db = require("./index");

const TECHNICIAN_FIELDS = [
  { column: "first_name", key: "firstName" },
  { column: "last_name", key: "lastName" },
  { column: "phone", key: "phone" },
  { column: "email", key: "email" },
  { column: "is_active", key: "isActive", transform: (v) => v !== false },
];

/**
 * Upsert a technician matched ONLY by (company_id, external_ref, source) —
 * the ServiceTrade id. Phone is never a matching/dedup key: two genuinely
 * distinct technicians (or, more commonly, distinct real-world people) can
 * share a phone, and matching on it risked silently merging two different
 * people's records together.
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
  const byRef = await db.query(
    `SELECT id FROM technicians WHERE company_id = $1 AND external_ref = $2 AND source = $3 LIMIT 1`,
    [companyId, String(externalRef), source]
  );

  if (byRef.rows.length > 0) {
    const r = await db.query(
      `UPDATE technicians SET
         first_name = $1, last_name = $2, phone = $3, email = $4,
         is_active = $5, additional_information = $6, updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [firstName, lastName, phone, email ?? null, isActive, JSON.stringify(additionalInformation), byRef.rows[0].id]
    );
    return r.rows[0];
  }

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
}

async function listByCompany(companyId, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? "SELECT * FROM technicians WHERE company_id = $1 AND is_active = true ORDER BY first_name"
    : "SELECT * FROM technicians WHERE company_id = $1 ORDER BY first_name";
  const r = await db.query(sql, [companyId]);
  return r.rows;
}

/**
 * Bulk upsert for large sync runs — replaces N sequential upsertByExternalRef
 * calls with a handful of multi-row statements. Identity is (company_id,
 * external_ref, source) only, same as upsertByExternalRef — no phone matching.
 *
 * @param {number} companyId
 * @param {Array<{companyId, externalRef, source, firstName, lastName, phone, email, isActive, additionalInformation}>} argsList
 * @returns {Promise<number>} rows processed
 */
async function bulkUpsertByExternalRef(companyId, argsList) {
  if (!argsList.length) return 0;
  await db.bulkUpsertByExternalRef("technicians", TECHNICIAN_FIELDS, argsList);
  return argsList.length;
}

module.exports = { upsertByExternalRef, bulkUpsertByExternalRef, listByCompany };
