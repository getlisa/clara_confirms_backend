-- Company-authored onsite instructions for a visit, keyed by service line —
-- NULL service_line means "general," applying to every service line for
-- that company; a value scopes it to just that one. Separate from
-- service_line_descriptions (084), which is soft-matched narration text —
-- this table is deterministic (matched on the appointment's own real
-- service_line field) and adds requires_response, so the agent knows
-- whether an instruction is delivered as a statement or must be asked as a
-- question and waited on. See graph/prompt.js's ONSITE_EXPECTATIONS.
CREATE TABLE IF NOT EXISTS onsite_instructions (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  service_line TEXT NULL,
  instruction TEXT NOT NULL,
  requires_response BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS onsite_instructions_company_idx ON onsite_instructions (company_id) WHERE active;
