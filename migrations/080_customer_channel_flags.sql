-- Per-customer channel selection: replace the single-valued
-- customers.preferred_channel ('voice'|'sms'|'web_chat'|NULL) with three
-- independent booleans so a customer can be reached by more than one
-- channel at once (e.g. sms + email simultaneously).
--
-- Combination rules (enforced in code, not SQL, since they depend on
-- attempt-in-progress state that isn't visible to a CHECK constraint):
--   - is_voice = true   -> voice is tried first; is_sms/is_email are a
--                          fallback only once voice attempts are exhausted.
--   - is_voice = false  -> is_sms and is_email fire together (both are
--                          delivery methods for the same chat-link
--                          confirmation, same as chat_link_delivery_method
--                          today, just resolved per customer instead of
--                          per company).
-- At least one flag must be true — enforced below, since a customer with
-- no channel at all can never be reached.

ALTER TABLE customers
  ADD COLUMN is_voice BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN is_sms   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN is_email BOOLEAN NOT NULL DEFAULT false;

-- Backfill from the column these replace.
UPDATE customers SET is_voice = true,  is_sms = false, is_email = false
 WHERE preferred_channel IS NULL OR preferred_channel = 'voice';
UPDATE customers SET is_voice = false, is_sms = true,  is_email = false
 WHERE preferred_channel = 'sms';
UPDATE customers SET is_voice = false, is_sms = false, is_email = true
 WHERE preferred_channel = 'web_chat';

ALTER TABLE customers
  ADD CONSTRAINT customers_channel_at_least_one CHECK (is_voice OR is_sms OR is_email);

ALTER TABLE customers DROP COLUMN preferred_channel;

-- The per-customer delivery resolved at queue time, carried on the row so
-- the dispatcher (which can run days later) doesn't need to re-read the
-- customer to know whether a web_chat send should email, text, or both —
-- same reasoning as job_date/job_name/etc already being snapshotted here.
ALTER TABLE scheduled_calls
  ADD COLUMN link_delivery VARCHAR CHECK (link_delivery IN ('email', 'sms', 'both'));
