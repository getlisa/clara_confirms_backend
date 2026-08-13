-- Who sent a chat link, and how: manual vs scheduler, plus the sender.
--
-- The frontend asked for `origin` on scheduled_calls. It goes on CHAT_LINKS
-- instead, and the reason matters: the manual send paths
-- (POST /chat-links/:id/send-email and /send-sms) create NO scheduled_calls row
-- at all — they call the email/SMS sender directly. Recording origin only on
-- scheduled_calls would therefore leave every hand-clicked send reading
-- "Not recorded", which is exactly the case the field exists to identify.
--
-- chat_links is also the entity the Logs page monitors, so the surfaced field is
-- identical either way.
--
-- `bypass_office_hours` was the nearest existing proxy and is genuinely
-- unreliable: manual-call.js sets it from `immediate === true`, so a manual send
-- scheduled for later records the same value as a scheduler send.

ALTER TABLE chat_links
  ADD COLUMN IF NOT EXISTS origin               TEXT NOT NULL DEFAULT 'scheduler',
  ADD COLUMN IF NOT EXISTS triggered_by_user_id INTEGER,
  ADD COLUMN IF NOT EXISTS triggered_by_name    TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'chat_links'::regclass AND conname = 'chat_links_origin_check'
  ) THEN
    ALTER TABLE chat_links
      ADD CONSTRAINT chat_links_origin_check CHECK (origin IN ('manual', 'scheduler'));
  END IF;
END $$;

-- Defaulting existing rows to 'scheduler' is honest: every historical link came
-- from the dispatcher sweep unless someone clicked, and all 10 existing rows do
-- have a scheduled_calls row (verified), so none of them were hand-sent.
--
-- triggered_by_* stays NULL for them rather than being invented — an
-- unattributed manual send must read as unattributed, not as somebody.

-- The same trio on scheduled_calls, for the calls side. The Logs page does not
-- ask for it yet, but a manually-dialled call and a swept one are equally
-- indistinguishable today, and manual-calls.js can populate it in one line.
ALTER TABLE scheduled_calls
  ADD COLUMN IF NOT EXISTS origin               TEXT NOT NULL DEFAULT 'scheduler',
  ADD COLUMN IF NOT EXISTS triggered_by_user_id INTEGER,
  ADD COLUMN IF NOT EXISTS triggered_by_name    TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'scheduled_calls'::regclass AND conname = 'scheduled_calls_origin_check'
  ) THEN
    ALTER TABLE scheduled_calls
      ADD CONSTRAINT scheduled_calls_origin_check CHECK (origin IN ('manual', 'scheduler'));
  END IF;
END $$;

-- The Logs detail sheet reads these per link; the index serves "show me what a
-- given person sent".
CREATE INDEX IF NOT EXISTS chat_links_origin_idx
  ON chat_links (company_id, origin, created_at DESC);
