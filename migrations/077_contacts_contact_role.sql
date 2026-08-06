-- Classify each contact as the primary point of contact vs a general one.
--
-- ServiceTrade marks a single contact as `primaryContact` on a job and/or its
-- location; every other contact on the account is an ordinary one. That
-- distinction had nowhere to live, so callers couldn't tell who to reach first
-- without re-deriving it from jobs.primary_contact_id every time.
--
-- Not to be confused with `type`/`types`, which hold the CRM's own free-text
-- labels ("on-site", "Accounts Payable", "financial"). This column is the
-- platform's own two-value classification.
--
-- Additive only; defaults every existing row to 'general', which the sync then
-- promotes to 'primary' where ServiceTrade says so.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS contact_role VARCHAR NOT NULL DEFAULT 'general';

ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS contacts_contact_role_check;
ALTER TABLE contacts
  ADD CONSTRAINT contacts_contact_role_check CHECK (contact_role IN ('primary', 'general'));

CREATE INDEX IF NOT EXISTS contacts_company_contact_role_idx ON contacts (company_id, contact_role);
