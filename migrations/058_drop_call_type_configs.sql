-- ─────────────────────────────────────────────────────────────────────────────
-- Consolidate to a single `campaigns` entity — CONTRACT phase.
--
-- Drops the now-redundant call_type_configs table and the leftover campaigns.call_type
-- column. Campaigns are the sole config entity: trigger + agent (prompt/greeting/
-- voicemail) + Retell provisioning artifacts, keyed by trigger_type.
--
-- ⚠️ Apply ONLY after the code cutover is deployed AND the Retell flow has been
-- re-provisioned per company (node ids are now `node_{campaign_key}`) and a live
-- call verified. Running this earlier removes data the old code still reads.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

DROP TABLE IF EXISTS call_type_configs;

ALTER TABLE campaigns DROP COLUMN IF EXISTS call_type;
