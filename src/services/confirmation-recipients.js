/**
 * Resolves who should receive a customer's confirmation — the customer's own
 * phone/email, and/or any of the extra `contacts` the customer has opted in
 * (`customers.confirmation_include_customer` / `confirmation_contact_ids`,
 * migration 081). One shared resolver reused by both the automatic sweep
 * (scheduler.js) and manual triggers (manual-call.js), so recipient
 * resolution can't drift between the two paths.
 *
 * Fast path: a customer with today's defaults (include_customer=true,
 * contact_ids=[]) resolves to exactly one recipient — recipientContactId:
 * null, meaning "the customer" — with zero extra queries beyond the
 * customer row the caller already has.
 */

const db = require("../db");

/**
 * @param {number} companyId
 * @param {object} customerRow — must carry: full_name, phone, email,
 *   confirmation_include_customer, confirmation_contact_ids
 * @returns {Promise<Array<{
 *   recipientContactId: number|null,  // null = the customer themselves
 *   name: string|null,
 *   phone: string|null,
 *   email: string|null,
 * }>>}
 */
async function resolveConfirmationRecipients(companyId, customerRow) {
  const recipients = [];

  if (customerRow.confirmation_include_customer !== false) {
    recipients.push({
      recipientContactId: null,
      name: customerRow.full_name ?? null,
      phone: customerRow.phone ?? null,
      email: customerRow.email ?? null,
    });
  }

  const contactIds = customerRow.confirmation_contact_ids || [];
  if (contactIds.length) {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, phone, mobile, alternate_phone, email
         FROM contacts WHERE company_id = $1 AND id = ANY($2::int[])`,
      [companyId, contactIds]
    );
    // A contact id that doesn't resolve (deleted, cross-tenant mistake) is
    // skipped — never lets one bad id blank out the whole recipient list.
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const cid of contactIds) {
      const c = byId.get(cid);
      if (!c) continue;
      recipients.push({
        recipientContactId: c.id,
        name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null,
        phone: c.phone || c.mobile || c.alternate_phone || null,
        email: c.email || null,
      });
    }
  }

  return recipients;
}

module.exports = { resolveConfirmationRecipients };
