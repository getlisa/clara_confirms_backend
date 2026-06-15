-- Per-tenant max concurrent calls.
-- Default 10 (Retell system cap 20 ÷ typical small-tenant burst load).
-- claimPending enforces a floor of 2 in code so every tenant always has its
-- guaranteed minimum even if an admin sets this to 0 or 1.

ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS max_concurrent_calls INTEGER NOT NULL DEFAULT 10;

-- Expand the call_priority enum to support the new HIGH/LOW tiers.
-- Order of urgency: callback < high < retry (legacy) < normal < low.
ALTER TABLE scheduled_calls DROP CONSTRAINT IF EXISTS scheduled_calls_call_priority_check;
ALTER TABLE scheduled_calls ADD  CONSTRAINT scheduled_calls_call_priority_check
  CHECK (call_priority IN ('callback','high','retry','normal','low'));
