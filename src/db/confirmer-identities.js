const db = require("./index");

/** @returns {Promise<{firstName,lastName,role,email,phone}|null>} */
async function getByToken(token) {
  const { rows } = await db.query(
    `SELECT first_name, last_name, role, email, phone FROM confirmer_identities WHERE chat_link_token = $1`,
    [token]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    role: row.role,
    email: row.email,
    phone: row.phone,
  };
}

async function upsert(token, { firstName, lastName, role, phone, email = null }) {
  await db.query(
    `INSERT INTO confirmer_identities (chat_link_token, first_name, last_name, role, email, phone)
          VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chat_link_token) DO UPDATE
        SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
            role = EXCLUDED.role, email = EXCLUDED.email, phone = EXCLUDED.phone,
            updated_at = NOW()`,
    [token, firstName, lastName, role, email, phone]
  );
}

module.exports = { getByToken, upsert };
