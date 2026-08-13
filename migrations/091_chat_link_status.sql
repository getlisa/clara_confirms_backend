-- Chat-link LIFECYCLE status, for monitoring.
--
-- This is ADDITIONAL to chat_links.state, which stays exactly as it is.
-- The two answer different questions and must not be conflated:
--
--   state  — where the CONVERSATION is (chat_started, confirmation_accepted,
--            collecting_contact_info, service_link_sent, reschedule_needed,
--            canceled, chat_ended). It drives the widget's input control via
--            computeInputHint, so changing its meaning changes the UI.
--   status — where the LINK is in its life: has it been sent, has anyone opened
--            it, did it reach an outcome, did it lapse. This is what an operator
--            watches.
--
-- Why `state` cannot answer it: its default is 'chat_started' AT CREATION, so a
-- link nobody has ever opened already reads as a started chat. Monitoring on
-- that field would report every unsent link as an active conversation.
--
--   sent        the link exists and has been (or is about to be) delivered
--   in_progress the customer opened it — the conversation is live
--   ended       an outcome came in and the agent closed the conversation
--   expired     the 24h window lapsed with no outcome, even if the customer had
--               opened it and left it half-finished
--
-- Transitions are monotonic and enforced in db/chat-links.js, not here:
-- sent → in_progress → ended, with expired reachable only from sent or
-- in_progress. `ended` is terminal — a conversation that reached an outcome must
-- never later be reported as expired just because its link lapsed.

ALTER TABLE chat_links
  ADD COLUMN IF NOT EXISTS status     TEXT NOT NULL DEFAULT 'sent',
  ADD COLUMN IF NOT EXISTS sent_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opened_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ended_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'chat_links'::regclass AND conname = 'chat_links_status_check'
  ) THEN
    ALTER TABLE chat_links
      ADD CONSTRAINT chat_links_status_check
      CHECK (status IN ('sent', 'in_progress', 'ended', 'expired'));
  END IF;
END $$;

-- Backfill from what the existing rows already tell us, so the first monitoring
-- view is not a wall of "sent" for links that plainly finished.
UPDATE chat_links
   SET status   = 'ended',
       ended_at = COALESCE(ended_at, last_opened_at, created_at)
 WHERE state = 'chat_ended' AND status = 'sent';

UPDATE chat_links
   SET status    = 'in_progress',
       opened_at = COALESCE(opened_at, last_opened_at)
 WHERE last_opened_at IS NOT NULL AND status = 'sent';

UPDATE chat_links
   SET status     = 'expired',
       expired_at = expires_at
 WHERE expires_at IS NOT NULL AND expires_at < NOW()
   AND status IN ('sent', 'in_progress');

UPDATE chat_links SET sent_at = COALESCE(sent_at, created_at) WHERE sent_at IS NULL;

-- The monitoring read: "what is outstanding for this company right now."
CREATE INDEX IF NOT EXISTS chat_links_status_idx
  ON chat_links (company_id, status, created_at DESC);

-- The expiry sweep's read — only rows that can still lapse.
CREATE INDEX IF NOT EXISTS chat_links_expiry_sweep_idx
  ON chat_links (expires_at)
  WHERE status IN ('sent', 'in_progress');
