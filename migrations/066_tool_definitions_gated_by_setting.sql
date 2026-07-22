-- A tool can be gated by a call_settings boolean beyond agent_can_make_changes.
-- NULL = gated only by is_write_tool (today's behavior, unaffected). A non-null
-- value names a call_settings column that must be TRUE for the tool to attach —
-- e.g. search_contact/create_contact are gated by service_link_enabled, since
-- there's no point offering the agent contact search/creation when the company
-- has the service-link feature turned off.
ALTER TABLE tool_definitions
  ADD COLUMN IF NOT EXISTS gated_by_setting VARCHAR;
