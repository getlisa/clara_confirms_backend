-- Per-customer confirmation recipients (customer-confirmation-contact-backend.md).
-- Lets a service manager pick, per customer, which people receive a
-- confirmation call/text/link — the customer's own phone/email, and/or one
-- or more other `contacts` (property manager, tenant, site contact).

ALTER TABLE customers
  ADD COLUMN confirmation_include_customer BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN confirmation_contact_ids INTEGER[] NOT NULL DEFAULT '{}';

-- scheduled_calls: which recipient this row is for. NULL = the customer's
-- own phone/email (today's only case, and the default going forward).
-- recipient_name/recipient_email are a snapshot at enqueue time, same
-- convention as the existing customer_name/job_name columns on this table —
-- a contacts row's phone/email is low-churn, so re-fetching fresh at
-- dispatch buys nothing a snapshot doesn't already cover.
ALTER TABLE scheduled_calls
  ADD COLUMN recipient_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN recipient_name  VARCHAR,
  ADD COLUMN recipient_email VARCHAR;

-- Postgres treats every NULL as distinct from every other NULL in a unique
-- index, so a naive (company_id, job_id, call_type, recipient_contact_id)
-- index would let TWO customer-recipient rows (both recipient_contact_id
-- NULL) coexist for the same job — exactly the duplicate the old index
-- existed to prevent. COALESCE to a sentinel (0 — no real contact id is
-- ever 0) collapses all "customer" rows onto one dedupe slot, while
-- distinct contact ids still dedupe independently of each other and of the
-- customer.
DROP INDEX IF EXISTS scheduled_calls_active_uniq;
CREATE UNIQUE INDEX scheduled_calls_active_uniq
  ON scheduled_calls (company_id, job_id, call_type, COALESCE(recipient_contact_id, 0))
  WHERE status IN ('pending', 'in_progress');

-- chat_links: one token per (job, recipient) instead of one per job — a
-- property manager and the customer each get their own independent
-- conversation/token for the same appointment.
ALTER TABLE chat_links
  ADD COLUMN recipient_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL;
