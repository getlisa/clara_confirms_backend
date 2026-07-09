-- ─────────────────────────────────────────────────────────────────────────────
-- Consolidate to a single `campaigns` entity — EXPAND phase.
--
-- A campaign is now the sole config entity: trigger behavior (when/who) + its own
-- agent (prompt/greeting/voicemail) + Retell provisioning artifacts. We rename
-- call_trigger_configs → campaigns and fold in the call_type_configs-only fields,
-- backfilling from each campaign's currently-linked call_type.
--
-- call_type_configs and campaigns.call_type are LEFT IN PLACE here; they are
-- dropped later in 058, after the code cutover + Retell re-provisioning are verified.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Rename the table (guarded — PG has no RENAME ... IF EXISTS).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema = 'public' AND table_name = 'call_trigger_configs')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables
                     WHERE table_schema = 'public' AND table_name = 'campaigns') THEN
    ALTER TABLE call_trigger_configs RENAME TO campaigns;
  END IF;
END $$;

-- 2. Fold in the call_type-only fields.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS name                    TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS voicemail_message       TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS retell_llm_id           VARCHAR;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS retell_agent_id         VARCHAR;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS retell_subagent_node_id VARCHAR;

-- 3. Backfill from the currently-linked call_type (campaigns.call_type = call_type_configs.type).
--    (begin_message/general_prompt were already backfilled by 056.)
UPDATE campaigns c
   SET name                    = COALESCE(c.name, ct.name),
       voicemail_message       = COALESCE(c.voicemail_message, ct.voicemail_message),
       retell_llm_id           = COALESCE(c.retell_llm_id, ct.retell_llm_id),
       retell_agent_id         = COALESCE(c.retell_agent_id, ct.retell_agent_id),
       retell_subagent_node_id = COALESCE(c.retell_subagent_node_id, ct.retell_subagent_node_id)
  FROM call_type_configs ct
 WHERE ct.company_id = c.company_id
   AND ct.type       = c.call_type
   AND c.name IS NULL;

-- Fallback display name for any campaign with no linked call_type name.
UPDATE campaigns SET name = trigger_type WHERE name IS NULL;
