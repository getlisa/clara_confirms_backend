const db = require("./index");

async function listByCompany(companyId) {
  const { rows } = await db.query(
    `SELECT title, description FROM service_line_descriptions WHERE company_id = $1 ORDER BY id`,
    [companyId]
  );
  return rows;
}

module.exports = { listByCompany };
