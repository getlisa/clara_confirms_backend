/**
 * Resolves who should receive a customer's confirmation. One shared resolver
 * reused by both the automatic sweep (scheduler.js) and manual triggers
 * (manual-call.js), so recipient resolution can't drift between the two paths.
 *
 * Precedence, highest first:
 *
 *   1. `customers.confirmation_contact_ids` — contacts a manager explicitly
 *      ticked for THIS customer (migration 081). A deliberate human choice
 *      outranks a company-wide default, so this short-circuits.
 *   2. `call_settings.confirmation_contact_types` — the company-wide default:
 *      contacts of this customer carrying one of the selected CRM contact
 *      types ("on-site", "scheduling", "property manager", …; migration 087).
 *      When this matches, the matched contacts REPLACE the customer-record
 *      recipient — the whole point is that the tagged contact becomes the
 *      default rather than the customer's switchboard number.
 *   3. Otherwise the customer record itself, per
 *      `customers.confirmation_include_customer`.
 *
 * Rule 3 is also the fallback whenever rule 2 finds nobody, so a company
 * enabling the setting can never silently stop confirming jobs for customers
 * whose contacts aren't typed.
 *
 * Fast path is unchanged: a customer on today's defaults with the setting off
 * resolves to exactly one recipient — `recipientContactId: null`, meaning "the
 * customer" — with zero extra queries beyond the customer row the caller has.
 */

const db = require("../db");
const todosDb = require("../db/todos");
const logger = require("../utils/logger");

/**
 * Cap on type-matched recipients per customer.
 *
 * The scheduler enqueues one call or chat link PER recipient, and a broad
 * selection fans out hard: on real company-9 data
 * {scheduling, property manager, on-site, management} matches 106 of 119
 * customers, and one customer has 59 matching contacts — 59 outbound calls for
 * a single job. Truncation is never silent; the dropped contacts are named in
 * a todo (see `logTruncation`).
 *
 * Does not apply to rule 1: explicitly-picked contacts are a human decision and
 * are always honoured in full.
 */
const MAX_TYPE_MATCHED_RECIPIENTS = 5;

const contactToRecipient = (c) => ({
  recipientContactId: c.id,
  name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || null,
  phone: c.phone || c.mobile || c.alternate_phone || null,
  email: c.email || null,
});

/**
 * Contacts of this customer carrying one of `types`.
 *
 * Contacts reach a customer through `contact_companies`. Ordering decides who
 * survives the cap: account-primary contacts first, then anyone actually
 * reachable, then the rest, then `id` so the result is stable across runs.
 * Unreachable contacts are deliberately kept (they can still win a cap slot
 * ahead of nobody) — the existing `missing_phone` todo path in the scheduler
 * reports them, which is how the gap becomes visible instead of invisible.
 */
async function fetchTypeMatchedContacts(companyId, customerId, types) {
  const { rows } = await db.query(
    // The two ordering keys are SELECTed, not just ordered on: with
    // SELECT DISTINCT, Postgres requires every ORDER BY expression to appear
    // in the select list.
    `SELECT DISTINCT c.id, c.first_name, c.last_name,
            c.phone, c.mobile, c.alternate_phone, c.email, c.contact_role,
            (c.contact_role = 'primary') AS is_primary,
            (COALESCE(c.phone, c.mobile, c.alternate_phone) IS NOT NULL
               OR NULLIF(c.email, '') IS NOT NULL) AS is_reachable
       FROM contacts c
       JOIN contact_companies cc ON cc.contact_id = c.id
      WHERE c.company_id = $1
        AND cc.customer_id = $2
        AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(c.types) t
               WHERE lower(btrim(t)) = ANY($3::text[])
            )
      ORDER BY is_primary DESC, is_reachable DESC, c.id`,
    [companyId, customerId, types]
  );
  return rows;
}

/** Record who the cap dropped, so truncation is auditable rather than silent. */
async function logTruncation(companyId, customerId, dropped) {
  const names = dropped
    .map((c) => [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || `contact ${c.id}`)
    .join(", ");
  logger.warn("Confirmation recipients truncated by contact-type cap", {
    companyId, customerId, cap: MAX_TYPE_MATCHED_RECIPIENTS, dropped: dropped.length, names,
  });
  try {
    // Idempotent per (company, customer): one open todo, not one per sweep.
    // Modelled on todosDb.createMissingPhone, which does the same re-use check
    // on metadata rather than adding another column.
    const existing = await db.query(
      `SELECT id FROM todos
        WHERE company_id = $1 AND type = 'RECIPIENTS_TRUNCATED' AND status = 'open'
          AND metadata->>'customer_id' = $2
        LIMIT 1`,
      [companyId, String(customerId)]
    );
    if (existing.rows.length) return;

    await todosDb.create({
      companyId,
      callId: null,
      type: todosDb.TODO_TYPES.RECIPIENTS_TRUNCATED,
      priority: "low", // FYI, not a blocked confirmation — 5 people were still contacted
      metadata: {
        customer_id: String(customerId),
        cap: MAX_TYPE_MATCHED_RECIPIENTS,
        dropped_count: dropped.length,
        dropped_contact_ids: dropped.map((c) => c.id),
        dropped_names: names,
        reason:
          `${dropped.length} contact(s) matched the confirmation contact types but were not ` +
          `contacted because of the ${MAX_TYPE_MATCHED_RECIPIENTS}-recipient cap. ` +
          `Narrow the selected types, or pick recipients explicitly on the customer.`,
      },
    });
  } catch (err) {
    // A todo is a reporting nicety — never fail recipient resolution over it.
    logger.warn("Could not record recipient-truncation todo", { companyId, customerId, error: err.message });
  }
}

/**
 * @param {number} companyId
 * @param {object} customerRow — must carry: id, full_name, phone, email,
 *   confirmation_include_customer, confirmation_contact_ids
 * @param {object} [opts]
 * @param {string[]} [opts.contactTypes] — call_settings.confirmation_contact_types.
 *   Omitted/empty disables rule 2 entirely, so callers that haven't loaded call
 *   settings keep the previous behaviour.
 * @returns {Promise<Array<{
 *   recipientContactId: number|null,  // null = the customer themselves
 *   name: string|null,
 *   phone: string|null,
 *   email: string|null,
 * }>>}
 */
async function resolveConfirmationRecipients(companyId, customerRow, { contactTypes = [] } = {}) {
  // ── Rule 1: explicit per-customer picks win ────────────────────────────────
  const contactIds = customerRow.confirmation_contact_ids || [];
  if (contactIds.length) {
    const recipients = [];
    if (customerRow.confirmation_include_customer !== false) {
      recipients.push({
        recipientContactId: null,
        name: customerRow.full_name ?? null,
        phone: customerRow.phone ?? null,
        email: customerRow.email ?? null,
      });
    }
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
      if (c) recipients.push(contactToRecipient(c));
    }
    return recipients;
  }

  // ── Rule 2: company-wide contact types ─────────────────────────────────────
  // customerRow.id is required to reach the contacts; callers that don't supply
  // it fall through to rule 3 rather than throwing.
  const customerId = customerRow.id ?? null;
  if (contactTypes.length && customerId) {
    const matched = await fetchTypeMatchedContacts(companyId, customerId, contactTypes);
    if (matched.length) {
      const kept = matched.slice(0, MAX_TYPE_MATCHED_RECIPIENTS);
      if (matched.length > kept.length) {
        await logTruncation(companyId, customerId, matched.slice(MAX_TYPE_MATCHED_RECIPIENTS));
      }
      return kept.map(contactToRecipient);
    }
  }

  // ── Rule 3: the customer record (also the fallback when rule 2 finds none) ─
  const recipients = [];
  if (customerRow.confirmation_include_customer !== false) {
    recipients.push({
      recipientContactId: null,
      name: customerRow.full_name ?? null,
      phone: customerRow.phone ?? null,
      email: customerRow.email ?? null,
    });
  }
  return recipients;
}

module.exports = { resolveConfirmationRecipients, MAX_TYPE_MATCHED_RECIPIENTS };
