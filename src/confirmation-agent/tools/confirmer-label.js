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

/**
 * A plain "First Last" label from a captured confirmer identity
 * (confirmer-identities.js — see capture-confirmer-identity.js), or null if
 * none has been captured for this session yet.
 */
function labelFromConfirmedBy(confirmedBy) {
  if (!confirmedBy?.firstName) return null;
  return [confirmedBy.firstName, confirmedBy.lastName].filter(Boolean).join(" ") || null;
}

/**
 * @param {object|null} [confirmedBy] — this session's captured identity
 *   (ctx.confirmedBy), when one exists. Takes priority over the platform
 *   contact lookup — it's a real name the customer gave us directly this
 *   conversation, not an inference from who the link was addressed to.
 */
async function resolveConfirmerLabel(companyId, recipientContactId, confirmedBy = null) {
  const fromConfirmedBy = labelFromConfirmedBy(confirmedBy);
  if (fromConfirmedBy) return fromConfirmedBy;
  if (!recipientContactId) return "the customer";
  const contact = await resolveContact(companyId, recipientContactId);
  return contact?.name || "the customer";
}

module.exports = { resolveConfirmerLabel, resolveContact, labelFromConfirmedBy };
