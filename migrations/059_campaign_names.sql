-- ─────────────────────────────────────────────────────────────────────────────
-- Canonical campaign display names.
--
-- Migration 057 backfilled `campaigns.name` from the linked call_type (e.g.
-- "Customer Confirmation"). Set the agreed campaign names instead. Unconditional
-- so it corrects already-migrated rows. Idempotent.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE campaigns SET name = CASE trigger_type
  WHEN 'scheduled_unconfirmed'  THEN 'Confirm Campaign'
  WHEN 'open_job_due_soon'      THEN 'Booking Campaign'
  WHEN 'quotation_pending'      THEN 'Quote Follow Up Campaign'
  WHEN 'technician_unconfirmed' THEN 'Technician Confirm Campaign'
  WHEN 'post_job_review'        THEN 'Post Job Feedback Campaign'
  ELSE name
END
WHERE trigger_type IN (
  'scheduled_unconfirmed','open_job_due_soon','quotation_pending','technician_unconfirmed','post_job_review'
);
