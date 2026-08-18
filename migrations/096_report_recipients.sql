-- Who gets the daily end-of-day operations report, and when.
--
-- Deliberately its own table rather than a column on `companies` or a flag on
-- `users`: a recipient is often someone with no platform login at all (an ops
-- mailbox, an owner who never signs in), and each person wants their OWN send
-- time — an ops lead at 9 PM, an owner reading it over coffee at 7 AM. Neither
-- of those fits a single company-wide setting or a login-only list.
--
-- `report_type` is future-proofed for the report types beyond #1 that were
-- flagged as coming later; today only 'daily_operations' is populated.
--
-- `send_at_local` is a TIME, not a TIMESTAMP — it repeats every day in the
-- company's own `default_timezone` (companies.default_timezone), resolved at
-- send time, never stored pre-converted to UTC. A company's timezone itself
-- essentially never changes, and if it ever did, every recipient's "9 PM"
-- should keep meaning 9 PM local without a backfill.
--
-- last_sent_for_date is the idempotency guard the sweep relies on: it stamps
-- the BUSINESS DATE the email covered (not a timestamp), so "have we already
-- sent today's edition" is a single equality check, immune to the sweep
-- running every 15 minutes and to a late catch-up run after an outage.

CREATE TABLE IF NOT EXISTS report_recipients (
  id                    SERIAL PRIMARY KEY,
  company_id            INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email                 TEXT NOT NULL,
  name                  TEXT,
  -- Optional link to a real platform login, for display only ("Jane's report")
  -- — never required, since a recipient may not have one.
  user_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
  report_type           TEXT NOT NULL DEFAULT 'daily_operations',
  send_at_local         TIME NOT NULL DEFAULT '21:00',
  -- Defaults to FALSE deliberately: this is a live mailing list to a real
  -- inbox, and a row created while setting up a recipient must not fire before
  -- someone has actually reviewed and enabled it.
  enabled               BOOLEAN NOT NULL DEFAULT false,
  last_sent_for_date    DATE,
  last_sent_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LOWER(email) can't sit in a table-level UNIQUE constraint — Postgres only
-- allows plain columns there — so the case-insensitive de-dup is a unique
-- index instead.
CREATE UNIQUE INDEX IF NOT EXISTS report_recipients_company_type_email_uniq
  ON report_recipients (company_id, report_type, LOWER(email));

-- The sweep's read: every enabled recipient for a company, cheaply.
CREATE INDEX IF NOT EXISTS report_recipients_due_idx
  ON report_recipients (company_id)
  WHERE enabled = true;
