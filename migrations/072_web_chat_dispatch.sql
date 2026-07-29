-- Wires up the (previously unused) web_chat_only channel_strategy: per-company
-- preference for how the chat-link should be delivered when the scheduler
-- dispatches a confirmation via web_chat instead of dialing/texting. Only
-- 'email' is actually implemented by the dispatcher yet — 'sms'/'both' are
-- accepted now so a follow-up SMS-link delivery doesn't need another migration.
ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS chat_link_delivery_method VARCHAR NOT NULL DEFAULT 'email'
    CHECK (chat_link_delivery_method IN ('email', 'sms', 'both'));

-- MISSING_EMAIL mirrors the existing MISSING_PHONE todo — surfaced when a
-- web_chat-only company has an unconfirmed appointment but the customer has
-- no email on file to send the chat link to.
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_type_check;
ALTER TABLE todos ADD CONSTRAINT todos_type_check
  CHECK (type IN ('NOT_PICKED','VOICEMAIL','ASKED_FOR_RESCHEDULE','ASKED_FOR_CANCELLATION','UNCONFIRMED','APPOINTMENT_NEEDED','MISSING_PHONE','SERVICE_OPPORTUNITY','SERVICE_LINK','CRM_SYNC','APPOINTMENT_CANCELLED','MISSING_EMAIL'));
