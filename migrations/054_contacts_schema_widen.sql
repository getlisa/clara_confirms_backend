-- Widen the contacts schema to match ServiceTrade's real /contact response
-- shape (confirmed via a real captured GET /contact list response — richer
-- than the smaller primaryContact object embedded on /location):
--   status       ("private"/"public" visibility — distinct from a location's active/inactive status)
--   types        (array, e.g. ["management"] — `type` singular is kept as-is for the primary type)
--   externalIds  (JSONB passthrough, e.g. {"peachtree": "...", "salesforce": "..."})
--   companies[]/locations[] — many-to-many, via new junction tables below
--
-- No new /contact bulk sync is wired up yet — contacts are still only
-- sourced from location.primaryContact, so these new columns/junctions will
-- mostly stay empty until that source can actually supply them. Building the
-- schema now avoids a second corrective migration later.

ALTER TABLE servicetrade_contacts
  ADD COLUMN IF NOT EXISTS status       VARCHAR,
  ADD COLUMN IF NOT EXISTS types        JSONB,
  ADD COLUMN IF NOT EXISTS external_ids JSONB;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS status       VARCHAR,
  ADD COLUMN IF NOT EXISTS types        JSONB,
  ADD COLUMN IF NOT EXISTS external_ids JSONB;

-- Many-to-many: a contact can be associated with multiple locations/companies.
CREATE TABLE contact_locations (
  contact_id  INTEGER NOT NULL REFERENCES contacts(id)  ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  UNIQUE (contact_id, location_id)
);

CREATE TABLE contact_companies (
  contact_id  INTEGER NOT NULL REFERENCES contacts(id)  ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  UNIQUE (contact_id, customer_id)
);
