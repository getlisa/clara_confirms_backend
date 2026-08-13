-- One row per actual send of a chat link.
--
-- What this answers that nothing else can: "was it emailed or texted first, by
-- whom, how many times, and did it go out?"
--
-- Before this the history was asymmetric and unrecoverable:
--   - chat_links.origin is LATEST-WINS. Each send overwrites the previous
--     answer, so the FIRST trigger type is simply gone once a link is re-sent.
--   - the manual send routes (POST /chat-links/:id/send-email and /send-sms)
--     create NO scheduled_calls row, so a hand re-send left no timestamp and no
--     evidence it happened at all beyond flipping that one column.
--   - scheduler sends DO leave a scheduled_calls row each (one real token has
--     16), but that table is not a history OF A LINK: 57 of 81 rows already
--     point at a chat_links row that no longer exists, because links cascade
--     away with their jobs while the dispatch rows survive.
--
-- Deliberately NOT a foreign key on the token. The log has to outlive the link
-- it describes — the whole point is answering "why didn't they get it?" after
-- the fact, including after a resync deleted the link. chat_link_id is kept as a
-- convenience and nulled if the link goes, but the token and destination are the
-- durable record.

CREATE TABLE IF NOT EXISTS chat_link_send_events (
  id                   BIGSERIAL PRIMARY KEY,
  company_id           INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- Text, not a reference: see above.
  chat_link_token      TEXT NOT NULL,
  chat_link_id         INTEGER REFERENCES chat_links(id) ON DELETE SET NULL,

  medium               TEXT NOT NULL CHECK (medium IN ('email', 'sms')),
  -- The address or number it actually went to, as used at send time. Not looked
  -- up later: the customer record changes, and the question is where it WENT.
  destination          TEXT,

  origin               TEXT NOT NULL CHECK (origin IN ('manual', 'scheduler')),
  triggered_by_user_id INTEGER,
  triggered_by_name    TEXT,
  -- Which dispatch row drove it, when the scheduler did. NULL for manual sends,
  -- which have no dispatch row at all.
  scheduled_call_id    INTEGER,

  -- Whether the provider accepted it. NOT whether it was delivered: a
  -- carrier-blocked SMS is accepted by Twilio and reported as sent (see
  -- sms-link-masking-frontend.md), and no statusCallback is configured yet. So
  -- `ok = true` means "handed over successfully", which is the strongest claim
  -- available today.
  ok                   BOOLEAN NOT NULL DEFAULT TRUE,
  error                TEXT,
  provider_message_id  TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The detail-sheet read: this link's sends, oldest first.
CREATE INDEX IF NOT EXISTS chat_link_send_events_token_idx
  ON chat_link_send_events (chat_link_token, created_at);

-- The monitoring read, and "what did this person send".
CREATE INDEX IF NOT EXISTS chat_link_send_events_company_idx
  ON chat_link_send_events (company_id, created_at DESC);

-- Backfill what is still recoverable: scheduler sends whose dispatch row
-- survives AND recorded a medium. link_delivery only exists from migration 080
-- (36 of 81 rows have it), and 'both' becomes two rows because it was two sends.
INSERT INTO chat_link_send_events
  (company_id, chat_link_token, chat_link_id, medium, destination, origin, scheduled_call_id, ok, created_at)
SELECT sc.company_id, sc.chat_link_token, cl.id,
       m.medium,
       CASE WHEN m.medium = 'email'
            THEN COALESCE(sc.recipient_email, sc.call_context->>'override_email')
            ELSE sc.phone_number END,
       'scheduler', sc.id, TRUE, COALESCE(sc.updated_at, sc.created_at)
  FROM scheduled_calls sc
  LEFT JOIN chat_links cl ON cl.token = sc.chat_link_token
  CROSS JOIN LATERAL (
    SELECT unnest(CASE sc.link_delivery
                    WHEN 'both' THEN ARRAY['email', 'sms']
                    WHEN 'email' THEN ARRAY['email']
                    WHEN 'sms'   THEN ARRAY['sms']
                    ELSE ARRAY[]::text[]
                  END) AS medium
  ) m
 WHERE sc.chat_link_token IS NOT NULL
   AND sc.status = 'completed'
ON CONFLICT DO NOTHING;
