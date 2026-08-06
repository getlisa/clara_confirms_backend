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

async function resolveConfirmerLabel(companyId, recipientContactId) {
  if (!recipientContactId) return "the customer";
  const { rows } = await db.query(
    `SELECT first_name, last_name FROM contacts WHERE id = $1 AND company_id = $2`,
    [recipientContactId, companyId]
  );
  const c = rows[0];
  const name = c ? [c.first_name, c.last_name].filter(Boolean).join(" ").trim() : "";
  return name || "the customer";
}

module.exports = { resolveConfirmerLabel };
