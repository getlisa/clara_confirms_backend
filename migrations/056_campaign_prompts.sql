-- ─────────────────────────────────────────────────────────────────────────────
-- Campaigns own their own prompt + greeting (Process 2 / Delivery).
--
-- A "campaign" is a call_trigger_configs row. It now carries its OWN agent prompt
-- (general_prompt) and greeting (begin_message) — the campaign is the basis of the
-- agent, rather than the prompt living on the shared call_type. Each campaign row
-- is already 1-per-trigger-per-company, so prompts are naturally per-campaign.
--
-- Backfill each campaign's prompt/greeting from its currently-linked call_type so
-- nothing is lost. Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE call_trigger_configs ADD COLUMN IF NOT EXISTS begin_message  TEXT;
ALTER TABLE call_trigger_configs ADD COLUMN IF NOT EXISTS general_prompt TEXT;

UPDATE call_trigger_configs t
   SET begin_message  = ct.begin_message,
       general_prompt = ct.general_prompt
  FROM call_type_configs ct
 WHERE ct.company_id = t.company_id
   AND ct.type       = t.call_type
   AND t.begin_message  IS NULL
   AND t.general_prompt IS NULL;
