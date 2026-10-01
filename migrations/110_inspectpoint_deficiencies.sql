-- InspectPoint deficiencies: sync them, link them to a location, and let them
-- reach the confirmation agent as services on the visit. CMAP-228.
--
-- WHY THIS IS NEEDED AT ALL. The canonical `deficiencies` table has existed
-- since CMAP-55 but holds only ServiceTrade rows, and carries NO location or
-- job reference — `additional_information` is just
-- {"servicetrade_deficiency_id": …}. So the one question both new features ask,
-- "what is open at this site", was unanswerable even for the data we had.
--
-- ── Which endpoint feeds this, and why a deprecated one ─────────────────────
-- Measured against Ultimate Fire's live tenant (439 deficiencies, 436 open):
--
--   GET /api/v2/deficiencies  (current)     8/439 linkable — 2%
--   GET /api/v1/deficiencies  (deprecated)  439/439 linkable — 100%
--   GET /api/v1/inspections?building_id=    0 — returns no deficiencies at all,
--                                           despite what the spec claims
--
-- v2 only exposes `inspection_id`, and those 439 rows reference 159 distinct
-- inspections of which our sync window holds TWO — almost every
-- deficiency-bearing inspection is historical. v1 carries a populated
-- `building` object on every row instead, across 91 buildings we already sync.
--
-- So v1 it is, deliberately, because 2% coverage is not a feature. The hedge is
-- `payload` below: the FULL raw row is retained, so if InspectPoint ever
-- withdraws v1 the migration to v2 is a re-normalize, not a re-fetch.

-- ── a. raw mirror ───────────────────────────────────────────────────────────
-- Shape follows migration 104's other inspectpoint_* tables: soft links by
-- InspectPoint id (never our own FKs), full payload, ip_updated_at.
CREATE TABLE IF NOT EXISTS inspectpoint_deficiencies (
  id                         BIGSERIAL PRIMARY KEY,
  company_id                 BIGINT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  inspectpoint_id            BIGINT NOT NULL,

  -- Straight from the payload's building.id. v1 hands this over directly, so
  -- unlike inspectpoint_jobs.inspectpoint_customer_id there is NO resolution
  -- step and no second query at write time.
  inspectpoint_location_id   BIGINT,
  -- Provenance only — which inspection raised it. Deliberately NOT the linkage
  -- path; see the header for what happened when it was.
  inspectpoint_inspection_id BIGINT,

  -- InspectPoint's own severity vocabulary
  -- (no_status|impairment|critical|non_critical|recommendation). Captured for
  -- when the data improves, but NOTHING depends on it: measured null on 436 of
  -- 439 rows in the only live tenant, and resolution_status null on all 439.
  deficiency_status          TEXT,
  resolution_status          TEXT,

  is_resolved                BOOLEAN,
  date_opened                TIMESTAMPTZ,
  date_resolved              TIMESTAMPTZ,
  reference_number           TEXT,
  unique_id                  TEXT,
  -- The actually-useful label: the failed inspection question, e.g.
  -- "Is wiring waterproof?" / "Service & Certification tag on system?".
  -- Present on 416 of 439 rows, where severity is present on 3.
  display_name               TEXT,
  notes                      TEXT,

  payload                    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_updated_at              TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, inspectpoint_id)
);

CREATE INDEX IF NOT EXISTS inspectpoint_deficiencies_company_idx
  ON inspectpoint_deficiencies (company_id);
CREATE INDEX IF NOT EXISTS inspectpoint_deficiencies_location_idx
  ON inspectpoint_deficiencies (company_id, inspectpoint_location_id);

-- ── b. the canonical table finally gets its linkage ─────────────────────────
ALTER TABLE deficiencies
  -- CASCADE: a deficiency is owned by its site. This matches how the CRM
  -- delete scripts already treat location-owned rows.
  ADD COLUMN IF NOT EXISTS location_id  INTEGER REFERENCES locations(id) ON DELETE CASCADE,
  -- SET NULL: a deficiency outlives the visit that found it.
  ADD COLUMN IF NOT EXISTS job_id       INTEGER REFERENCES jobs(id)      ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS status       TEXT,
  ADD COLUMN IF NOT EXISTS is_resolved  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS opened_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolved_at  TIMESTAMPTZ;

-- The hot read for BOTH features: open deficiencies at a site.
CREATE INDEX IF NOT EXISTS deficiencies_open_by_location_idx
  ON deficiencies (company_id, location_id) WHERE is_resolved = false;

-- The 105 pre-existing ServiceTrade rows get NULLs here. That is intended and
-- additive — backfilling their linkage is a separate normalize change, since
-- servicetrade_deficiencies carries its own.

-- ── c. the discriminator on appointment_services ────────────────────────────
-- THIS COLUMN IS LOAD-BEARING, not bookkeeping.
--
-- Deficiencies reach the agent as appointment_services rows so they travel the
-- existing service_details path. But in job-confirmation-context.js,
-- `service_lines`, `service_names`, `service_details` AND `service_summary` are
-- all derived from that same set — and `service_summary` feeds the agent's
-- OPENING LINE. Without a discriminator, Kelly would open a call with
-- "Backflow, Alarm Systems, and valve tamper switch repair", announcing
-- unscheduled repairs as though they were the booked work.
--
-- `kind` partitions the two. DEFAULT 'service' means every existing row and
-- every existing writer is untouched, so the opening line cannot regress.
ALTER TABLE appointment_services
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'service'
    CHECK (kind IN ('service', 'deficiency_repair')),
  ADD COLUMN IF NOT EXISTS deficiency_id INTEGER REFERENCES deficiencies(id) ON DELETE CASCADE;

-- Partial index: the projection reads and replaces only the repair rows, and
-- must never scan the far larger set of real services to do it.
CREATE INDEX IF NOT EXISTS appointment_services_repairs_idx
  ON appointment_services (company_id, appointment_id)
  WHERE kind = 'deficiency_repair';
