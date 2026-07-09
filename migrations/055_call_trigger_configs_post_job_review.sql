-- ─────────────────────────────────────────────────────────────────────────────
-- Campaigns (Process 2 / Delivery): admit the new `post_job_review` campaign.
--
-- call_trigger_configs backs the configurable, per-company "campaigns" (each with
-- an on/off toggle). Widen the trigger_type CHECK to allow post_job_review.
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE call_trigger_configs
  DROP CONSTRAINT IF EXISTS call_trigger_configs_trigger_type_check;

ALTER TABLE call_trigger_configs
  ADD CONSTRAINT call_trigger_configs_trigger_type_check
  CHECK (trigger_type IN (
    'scheduled_unconfirmed',
    'quotation_pending',
    'open_job_due_soon',
    'technician_unconfirmed',
    'post_job_review'
  ));
