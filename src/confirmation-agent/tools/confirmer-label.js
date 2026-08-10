/**
 * Resolve a human-readable label for whoever is confirming, at confirm time
 * — stamped directly onto the appointment (see confirm-appointment.js/
 * confirm-job-appointments.js) rather than re-looked-up later, so it can't
 * break if the contact record later changes or is removed.
 *
 * recipientContactId is null when the recipient is the customer themself
 * (migration 081's confirmation-recipients feature — the customer's own
 * chat has no contacts row to look up).
 */
const db = require("../../db");

/** Raw contact lookup — name/email/phone, or null if not found. */
async function resolveContact(companyId, contactId) {
  if (!contactId) return null;
  const { rows } = await db.query(
    `SELECT first_name, last_name, email, phone, mobile FROM contacts WHERE id = $1 AND company_id = $2`,
    [contactId, companyId]
  );
  const c = rows[0];
  if (!c) return null;
  return {
    name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null,
    email: c.email || null,
    phone: c.mobile || c.phone || null,
  };
}

async function resolveConfirmerLabel(companyId, recipientContactId) {
  if (!recipientContactId) return "the customer";
  const contact = await resolveContact(companyId, recipientContactId);
  return contact?.name || "the customer";
}

module.exports = { resolveConfirmerLabel, resolveContact };
