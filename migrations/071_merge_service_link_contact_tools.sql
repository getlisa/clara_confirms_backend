-- search_contact + create_contact were two separate tools the agent had to
-- sequence itself (search first, then conditionally create) — in practice the
-- model reliably asked for name/role before ever searching, even after
-- several rounds of prompt/description strengthening. Merging into one
-- deterministic tool moves the "search first, create only if no match" logic
-- into our own code instead of the model's judgment: even if the model
-- collects all fields upfront, the handler always searches by email first and
-- uses an existing match if one exists, ignoring any name/role passed in that
-- case — guaranteeing no duplicate contact is ever created regardless of
-- what order the model asks its questions in.

UPDATE tool_definitions SET enabled = false, updated_at = NOW()
WHERE name IN ('search_contact', 'create_contact') AND call_type = 'customer_confirmation';

INSERT INTO tool_definitions
  (call_type, name, description, endpoint, method, parameters,
   speak_during_execution, speak_after_execution, is_write_tool, gated_by_setting, sort_order, enabled)
VALUES
  (
    'customer_confirmation',
    'resolve_service_link_contact',
    'Resolve who should receive the service link. Call this as soon as you have the customer''s email — do not wait to also collect their name/role first. Pass only email on your first call. The tool searches for an existing contact by that email automatically: if found, it is used immediately (you do not need to provide name/role, and any you did provide are ignored) and the response status is "found". If no existing contact matches, the response status is "need_more_info" — only then ask the customer for their first_name, last_name, and role (e.g. management, billing, on-site), and call this tool again including those fields to create a new contact (response status "created"). Never call this twice with the same information; only call again once you have new fields to add.',
    '/retell/tools/resolve_service_link_contact',
    'POST',
    '{"type":"object","required":["email"],"properties":{"email":{"type":"string","description":"The confirmed email address to send the service link to. Required on every call."},"first_name":{"type":"string","description":"First name — only include on a second call, after a first call returned need_more_info."},"last_name":{"type":"string","description":"Last name — only include on a second call, after a first call returned need_more_info."},"role":{"type":"string","description":"The contact''s role/type as stated by the customer, e.g. management, billing, on-site — only include on a second call, after a first call returned need_more_info."}}}'::jsonb,
    true, true, true, 'service_link_enabled', 20, true
  )
ON CONFLICT DO NOTHING;
