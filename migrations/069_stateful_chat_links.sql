-- Stateful web-chat backend: explicit conversation state per chat link, the
-- real Retell chat session id (created lazily on first open), and Phase-B
-- prep (a 'web_chat' channel value, and where the dispatcher will stash a
-- chat-link token instead of a live retell_call_id).
-- See /Users/Shivam/.claude/plans/zippy-weaving-flame.md for design context.

ALTER TABLE chat_links
  ADD COLUMN IF NOT EXISTS retell_chat_id TEXT,
  ADD COLUMN IF NOT EXISTS state VARCHAR NOT NULL DEFAULT 'chat_started'
    CHECK (state IN (
      'chat_started', 'confirmation_accepted', 'collecting_contact_info',
      'service_link_sent', 'reschedule_needed', 'reschedule_pending_confirmation',
      'canceled', 'chat_ended'
    ));

-- Phase B: set when the dispatcher emails a chat link instead of dialing/texting.
-- Distinct from retell_call_id, which stays null until the customer actually
-- opens the link and a real Retell chat session gets created.
ALTER TABLE scheduled_calls
  ADD COLUMN IF NOT EXISTS chat_link_token TEXT;

-- Widen channel/preferred_channel/channel_strategy CHECK constraints to allow
-- 'web_chat' alongside the existing 'voice'/'sms' values.
ALTER TABLE scheduled_calls DROP CONSTRAINT IF EXISTS scheduled_calls_channel_check;
ALTER TABLE scheduled_calls ADD CONSTRAINT scheduled_calls_channel_check
  CHECK (channel IN ('voice', 'sms', 'web_chat'));

ALTER TABLE calls DROP CONSTRAINT IF EXISTS calls_channel_check;
ALTER TABLE calls ADD CONSTRAINT calls_channel_check
  CHECK (channel IN ('voice', 'sms', 'web_chat'));

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_preferred_channel_check;
ALTER TABLE customers ADD CONSTRAINT customers_preferred_channel_check
  CHECK (preferred_channel IN ('voice', 'sms', 'web_chat'));

ALTER TABLE call_settings DROP CONSTRAINT IF EXISTS call_settings_channel_strategy_check;
ALTER TABLE call_settings ADD CONSTRAINT call_settings_channel_strategy_check
  CHECK (channel_strategy IN ('voice_only', 'sms_only', 'voice_then_sms_fallback', 'web_chat_only'));
