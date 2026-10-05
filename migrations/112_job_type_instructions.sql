-- Pre-visit instructions the CUSTOMER must act on before the technician
-- arrives, authored by the company and keyed by job type (CMAP-230).
--
-- The driving example, from the Ultimate Fire kickoff:
--   "Fire suppression: appliances must be turned off when the technician
--    arrives. The team can't inspect with fryers on."
--
-- ── Why a third table and not one of the two that already exist ─────────────
-- This is deliberately separate from both neighbours, because all three answer
-- different questions:
--
--   onsite_instructions (101)      keyed by service_line, chat only. What
--                                  happens ON SITE during the visit.
--   service_line_descriptions (084) soft LLM-matched narration, voice only,
--                                  baked into the prompt by prompt-sync.
--   this table                     keyed by JOB TYPE. What the customer must
--                                  do BEFORE the visit, or it cannot proceed.
--
-- Nothing in 101 or 084 is replaced, migrated or read by this feature.
--
-- ── Why job_type is the right key ──────────────────────────────────────────
-- For InspectPoint, jobs.job_type IS the inspection/system type — "Fire
-- Suppression", "Hood Cleaning", "Fire Extinguisher" (deriveInspectionLabel).
-- Since migration 111 released service_lines to hold deficiencies, job_type is
-- now the ONLY place that system type lives, which makes it the only key that
-- can express the example above.
--
-- For ServiceTrade job_type is a coarser category slug — "inspection",
-- "installation", "service_call". A ServiceTrade company can scope an
-- instruction to "all inspections" but not to suppression specifically; there
-- the system type lives in service_lines. Known and accepted, not a defect.
--
-- See docs/previsit-instructions-frontend.md for the frontend contract.
CREATE TABLE IF NOT EXISTS job_type_instructions (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  -- Matched against jobs.job_type, stored lower+trim normalised so a value
  -- picked from the picker endpoint and one typed by hand still agree.
  -- Verified safe to match exactly: for every company,
  -- count(DISTINCT job_type) = count(DISTINCT lower(btrim(job_type))), i.e.
  -- there are no case or whitespace variants in the live data — unlike
  -- call_settings.confirmation_contact_types, where company 9 alone carries
  -- 140 spellings of a handful of values.
  job_type TEXT NOT NULL,

  -- The display form as the user chose it ("Fire Suppression"), so the UI can
  -- echo their own capitalisation back instead of the normalised key.
  job_type_label TEXT,

  instruction TEXT NOT NULL,

  -- Whether the agent must WAIT for the customer to acknowledge rather than
  -- reading the instruction past them. "Turn the fryers off" is the whole
  -- reason this ticket exists and the visit fails outright if it is missed, so
  -- it needs to be more than narration. Mirrors
  -- onsite_instructions.requires_response (101), which exists for the same
  -- reason on the on-site side.
  requires_acknowledgement BOOLEAN NOT NULL DEFAULT false,

  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The resolver's only read: active instructions for one company + job type.
CREATE INDEX IF NOT EXISTS job_type_instructions_lookup_idx
  ON job_type_instructions (company_id, job_type) WHERE active;

-- The same instruction text twice on one job type is a duplicate, not two
-- rules — the agent would say it twice. md5() because the column is unbounded
-- TEXT and a btree entry is capped at ~2704 bytes.
CREATE UNIQUE INDEX IF NOT EXISTS job_type_instructions_uniq
  ON job_type_instructions (company_id, job_type, md5(instruction));
