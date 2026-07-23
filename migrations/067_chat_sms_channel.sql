-- SMS/chat channel support for end-customer confirmation calls.
-- See /Users/Shivam/.claude/plans/zippy-weaving-flame.md for design context.

-- Per-company Retell chat agent + SMS rollout status (ops-controlled; the
-- Retell SDK exposes no queryable "is SMS approved yet" flag, so we track it
-- ourselves).
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS retell_chat_agent_id TEXT,
  ADD COLUMN IF NOT EXISTS sms_status VARCHAR NOT NULL DEFAULT 'not_configured'
    CHECK (sms_status IN ('not_configured', 'pending_approval', 'live'));

-- Company-wide channel strategy + callback-to-chat toggle.
ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS channel_strategy VARCHAR NOT NULL DEFAULT 'voice_only'
    CHECK (channel_strategy IN ('voice_only', 'sms_only', 'voice_then_sms_fallback')),
  ADD COLUMN IF NOT EXISTS sms_on_callback_enabled BOOLEAN NOT NULL DEFAULT false;

-- Per-customer channel override (null = defer to company channel_strategy).
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS preferred_channel VARCHAR
    CHECK (preferred_channel IN ('voice', 'sms'));

-- Which channel fired/produced each queued call and each logged call.
-- retell_call_id is reused as the opaque Retell identifier for both a voice
-- call_id and a chat/sms chat_id — channel disambiguates which Retell API
-- produced it.
ALTER TABLE scheduled_calls
  ADD COLUMN IF NOT EXISTS channel VARCHAR NOT NULL DEFAULT 'voice'
    CHECK (channel IN ('voice', 'sms'));

ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS channel VARCHAR NOT NULL DEFAULT 'voice'
    CHECK (channel IN ('voice', 'sms'));
