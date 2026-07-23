-- Two new tools for the stateful web-chat backend. Both attach only to the
-- customer_confirmation node (same node voice/SMS already share) and are
-- harmless no-ops there for voice/SMS calls — their handlers key off
-- chat_links.retell_chat_id, which simply won't match a voice/SMS call_id.

INSERT INTO tool_definitions
  (call_type, name, description, endpoint, method, parameters,
   speak_during_execution, speak_after_execution, is_write_tool, gated_by_setting, sort_order, enabled)
VALUES
  (
    'customer_confirmation',
    'report_customer_intent',
    'For chat sessions only (when {{is_chat_session}} is true): silently report the customer''s decision as soon as it becomes clear, even before you''ve taken the corresponding action (e.g. before you''ve collected a reschedule date, or before confirm_appointment/cancel_appointment actually runs). Do not mention this tool to the customer. Not needed for voice calls.',
    '/retell/tools/report_customer_intent',
    'POST',
    '{"type":"object","required":["intent"],"properties":{"intent":{"type":"string","enum":["wants_confirm","wants_reschedule","wants_cancel","other"],"description":"The customer''s decision, as soon as it is clear."}}}'::jsonb,
    false, false, false, NULL, 30, true
  ),
  (
    'customer_confirmation',
    'get_service_link',
    'For chat sessions only: fetch the live ServiceTrade service-link URL for this job and paste it directly into your chat message, in addition to it being emailed. Only call this after the customer has confirmed and a contact/email has been resolved (after search_contact/create_contact).',
    '/retell/tools/get_service_link',
    'POST',
    '{"type":"object","required":[],"properties":{}}'::jsonb,
    true, true, false, 'service_link_enabled', 31, true
  )
ON CONFLICT DO NOTHING;
