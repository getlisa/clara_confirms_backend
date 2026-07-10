-- ─────────────────────────────────────────────────────────────────────────────
-- Backend onboarding: persist a completion marker on the company.
-- GET /onboarding/status computes per-step readiness; onboarding_completed_at is
-- stamped when the company becomes operational (or when explicitly marked complete).
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE companies ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
