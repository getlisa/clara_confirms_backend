-- Link a job to its location and its primary contact.
--
-- ServiceTrade's /job/{id} response carries BOTH a job-level `primaryContact`
-- (a full contact object) and a `location` — neither of which had anywhere to
-- land on the platform `jobs` table, so both were being dropped. Without them
-- there is no path from a job to the people to contact about it, which is what
-- GET /jobs/:id needs in order to label a contact as "primary".
--
-- Additive only: no existing column is renamed or removed.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS location_id        INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS primary_contact_id INTEGER REFERENCES contacts(id)  ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS jobs_location_id_idx        ON jobs (location_id);
CREATE INDEX IF NOT EXISTS jobs_primary_contact_id_idx ON jobs (primary_contact_id);
