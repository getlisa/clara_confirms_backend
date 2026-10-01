-- Re-map InspectPoint entities onto the platform's own vocabulary, and stop the
-- status mappers from silently guessing.
--
-- ── Why the mapping changes ─────────────────────────────────────────────────
-- Today: Account -> customers, Building -> locations, inspection_type ->
-- service_lines AND jobs.job_type, Deficiency -> deficiencies.
--
-- The problem with Account-as-customer is recorded in the code itself: every
-- InspectPoint Account structurally has no phone and no email field at all, on
-- 100% of rows. The Building is where `phone_number` lives. So the entity we
-- actually call was not the one we stored as the customer, which is why the
-- confirmation email had to fall back to the location name to avoid reading a
-- phone number aloud as the customer's name.
--
-- New: a Building becomes BOTH the customer and the location (same
-- external_ref, two tables — each has its own (company_id, external_ref,
-- source) unique index, so this is safe). The Account survives as reference
-- data in additional_information. inspection_type keeps feeding jobs.job_type
-- and is released from service_lines, which now holds deficiencies — the thing
-- you would actually perform a service on.

-- ── a. deficiencies: the inspection reference and the raw detail ────────────
ALTER TABLE deficiencies
  ADD COLUMN IF NOT EXISTS service_line_id     INTEGER REFERENCES service_lines(id) ON DELETE SET NULL,

  -- InspectPoint's inspection id, deliberately NOT a foreign key.
  --
  -- Every deficiency carries one (verified: 436/436 of the live tenant's open
  -- rows), but those inspections are Completed / Waiting for Review / Started,
  -- and the inspection sync pulls only Pending + Scheduled because `jobs` means
  -- "open work the dispatcher acts on". A sample of 12 came back 9 Waiting for
  -- Review, 2 Completed, 1 Started — so an FK would be null for nearly all of
  -- them. Keeping the external id plus `detail.inspection` below makes the
  -- mapping exact without turning years of finished inspections into jobs.
  ADD COLUMN IF NOT EXISTS external_parent_ref TEXT,

  -- asset_details + related_device + the embedded inspection, verbatim.
  --
  -- Six different key sets, measured across 436 open rows, with no common
  -- schema beyond `System/Asset Type`:
  --   Inspection custom inspection (183) Display Name, Question, Answer
  --   Asset (99)                         Asset Type, Asset Name, Manufacturer,
  --                                      Model, Question, Answer, Location of
  --                                      system cylinders
  --   Equipment (75)                     Equipment type (+4 rarer keys)
  --   Inspection external form (66)      Display Name
  --   Fire Extinguisher (8)              Extinguisher Group Name, ID Number,
  --                                      Type, Weight, ...
  --   Fire Exit Sign (5)                 Exit Sign Group Name, Battery Type, ...
  -- Flattening this into columns would fit one shape and misrepresent the other
  -- five, so it is stored and served whole and the frontend interprets it.
  ADD COLUMN IF NOT EXISTS detail              JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS deficiencies_parent_ref_idx
  ON deficiencies (company_id, external_parent_ref);

-- ── b. statuses: represent the unpredictable instead of guessing ────────────
-- Two real defects this fixes, not hypotheticals:
--
--   mapVisitStatus is `VISIT_STATUS_MAP[visitStatus] || "scheduled"` with NO
--   warning. An InspectPoint visit status we have never seen became a SCHEDULED
--   APPOINTMENT — which the dispatcher then picks up and the agent calls a
--   customer about. That is the worst available default.
--
--   mapJobStatus warns but still defaults to `open`, which also means live work.
--
-- `unknown` gives both a landing place that is visible and INERT: it is not in
-- the sweeps that pick work up, so an unrecognised CRM state can no longer
-- cause an outbound call. The raw value keeps surviving verbatim in
-- inspectpoint_jobs.status_code (migration 104), so a better mapping can be
-- re-run over stored data later without re-fetching anything — which is what
-- makes `unknown` a holding pen rather than data loss.
--
-- `in_progress` on appointments also removes an existing lie: VISIT_STATUS_MAP
-- maps `started -> scheduled` only because the CHECK had no such value.
ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_status_check;
ALTER TABLE appointments ADD CONSTRAINT appointments_status_check
  CHECK (status IN ('scheduled', 'confirmed', 'rescheduled', 'cancelled',
                    'completed', 'no_show', 'in_progress', 'unknown'));

ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check
  CHECK (status IN ('open', 'pending', 'scheduled', 'rescheduled', 'confirmed',
                    'in_progress', 'completed', 'cancelled', 'unknown'));

-- Both are pure widenings — every value that was legal still is, so no existing
-- row can violate them and no backfill is needed.
