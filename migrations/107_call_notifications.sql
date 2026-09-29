-- Per-conversation notification emails: recording + transcript + summary,
-- mailed to nominated addresses after each outbound call/chat.
--
-- Driven by CMAP-224 (go-live blocker: "every outbound call recording and
-- transcript must be reviewable") and CMAP-226 (deliver it by email, with a
-- subject line distinct from inbound).
--
-- Before this, a recording was reviewable NOWHERE: Retell sends recording_url
-- on call_analyzed and routes/retell.js dropped it, and the calls table
-- (migration 018) had no column to keep it in.

-- ── a. Keep the recording ────────────────────────────────────────────────────
-- Retell's own URL. It is read ONLY by the backend: the notification email
-- attaches the audio bytes (so the mail client plays them inline) and the
-- portal streams them through GET /calls/:id/recording. The URL itself is
-- never put in an email or handed to a browser — it is an unauthenticated
-- link to a customer conversation, and an email is forwardable.
--
-- public_log_url is Retell's own debug view of the conversation. Stored for
-- support/debugging only; same rule — backend eyes only.
ALTER TABLE calls
  ADD COLUMN IF NOT EXISTS recording_url  TEXT,
  ADD COLUMN IF NOT EXISTS public_log_url TEXT;

-- ── b. The master switch ────────────────────────────────────────────────────
-- Defaults FALSE. This mails real inboxes on every conversation, so it must be
-- turned on deliberately per company — never on by virtue of the row existing.
ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS call_notification_enabled BOOLEAN NOT NULL DEFAULT false;

-- ── c. Who gets notified, and for which outcomes ────────────────────────────
-- Its own table rather than a column on companies, for the same reason
-- report_recipients (migration 096) is: a recipient is usually someone with no
-- platform login at all (an ops mailbox, an owner who never signs in).
--
-- `events` is PER RECIPIENT, not per company. Asked for explicitly: an ops lead
-- wants every outcome, while an owner wants only cancellations and no-answers.
-- A single company-wide list cannot express that, and the whole point of the
-- feature is that people can stop the mail they don't want.
--
-- The seven keys mirror db/todos.js deriveTodoType 1:1 — that function is
-- already the canonical, priority-ordered outcome classifier for a
-- conversation, and it returns exactly ONE answer, so one conversation can
-- never produce two emails to the same address. 'confirmed' is its null case
-- (the happy path, which raises no todo).
--
-- TEXT[] not jsonb: node-postgres serialises a JS array straight into it, so
-- the generic parameter builder in db/call-notification-recipients.js needs no
-- special case. Same reasoning as call_settings.confirmation_contact_types
-- (migration 087).
CREATE TABLE IF NOT EXISTS call_notification_recipients (
  id            SERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT,

  events        TEXT[] NOT NULL DEFAULT ARRAY[
                  'confirmed',
                  'reschedule_requested',
                  'cancellation_requested',
                  'appointment_needed',
                  'unconfirmed',
                  'voicemail',
                  'not_picked'
                ]::text[],

  -- FALSE deliberately, exactly as report_recipients does: a row created while
  -- someone is still filling in the form must not start emailing anyone.
  enabled       BOOLEAN NOT NULL DEFAULT false,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LOWER(email) cannot sit in a table-level UNIQUE constraint — Postgres only
-- allows plain columns there — so the case-insensitive de-dup is an index.
CREATE UNIQUE INDEX IF NOT EXISTS call_notification_recipients_company_email_uniq
  ON call_notification_recipients (company_id, LOWER(email));

-- The hot read: enabled recipients for one company at enqueue time.
CREATE INDEX IF NOT EXISTS call_notification_recipients_enabled_idx
  ON call_notification_recipients (company_id)
  WHERE enabled = true;

-- ── d. The queue AND the audit ledger ───────────────────────────────────────
-- One row per (conversation, recipient). It is both:
--   1. the work queue a cron sweep drains, and
--   2. the permanent record of what was sent where, and whether the audio made it.
--
-- WHY A QUEUE AND NOT AN INLINE SEND. Retell types recording_url as optional
-- ("Available after call ends") and the S3 object can lag the call_analyzed
-- webhook by moments. Fetched inline in the webhook, that lag costs the audio
-- on that email PERMANENTLY — the precise failure that makes a go-live blocker
-- look fixed when it is not. Deferring gets retries for free, and keeps the
-- webhook off the network (routes/retell.js must return fast; see its comment
-- about Vercel freezing the function once the response is sent).
--
-- retell_call_id is TEXT and carries no foreign key, deliberately: same
-- reasoning as chat_link_send_events (migration 093) — the log has to outlive
-- the row it describes so "why didn't they get it?" stays answerable.
CREATE TABLE IF NOT EXISTS call_notification_sends (
  id                 BIGSERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  call_id            INTEGER,
  retell_call_id     TEXT NOT NULL,

  -- Nulled if the recipient is later deleted; email/event stay as the durable
  -- record of where this actually went.
  recipient_id       INTEGER REFERENCES call_notification_recipients(id) ON DELETE SET NULL,
  email              TEXT NOT NULL,
  event              TEXT NOT NULL,
  channel            TEXT NOT NULL DEFAULT 'voice',

  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sent', 'failed')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  next_attempt_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- FALSE means the email went out with transcript + summary only. After the
  -- retry budget is spent the email is sent ANYWAY rather than held forever:
  -- a notification that silently never arrives is worse than one missing an
  -- attachment. This column is how that case stays visible.
  recording_attached BOOLEAN,
  attachment_bytes   INTEGER,

  last_error         TEXT,
  sent_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The dedup guarantee. Retell retries a webhook on any non-2xx, and
-- handleCallAnalyzed is re-entrant by design (upserts + comment markers) — but
-- a duplicate EMAIL is visible to the customer in a way a duplicate upsert is
-- not. Enqueue is ON CONFLICT DO NOTHING against this index, so a replayed
-- webhook adds no second row and therefore sends no second email.
CREATE UNIQUE INDEX IF NOT EXISTS call_notification_sends_call_email_uniq
  ON call_notification_sends (retell_call_id, LOWER(email));

-- The sweep's only read: what is due right now, oldest first.
CREATE INDEX IF NOT EXISTS call_notification_sends_due_idx
  ON call_notification_sends (next_attempt_at)
  WHERE status = 'pending';

-- The portal read: this conversation's delivery history.
CREATE INDEX IF NOT EXISTS call_notification_sends_call_idx
  ON call_notification_sends (company_id, retell_call_id);
