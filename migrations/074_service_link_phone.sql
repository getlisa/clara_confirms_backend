-- Adds a phone column to service_link_messages so the service link can be
-- texted (via Twilio) in addition to ServiceTrade's own email send, when a
-- phone number is available for the resolved recipient.
ALTER TABLE service_link_messages
  ADD COLUMN IF NOT EXISTS phone VARCHAR;
