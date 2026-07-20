-- Service Link write-back: after a confirmed customer_confirmation call, email
-- the job's ServiceTrade "Service Link" to a contact (resolved/created live
-- during the call). This migration adds:
--   1. service_link_messages — tracks each send with a lifecycle status so the
--      platform can surface anything that did not send.
--   2. SERVICE_LINK todo type — raised when a link could not be sent.
--   3. call_settings.service_link_enabled — per-company opt-in (mirrors
--      crm_comment_writeback_enabled). Off by default.

-- ── 1. service_link_messages ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_link_messages (
  id                      SERIAL PRIMARY KEY,
  company_id              INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scheduled_call_id       INTEGER,
  retell_call_id          VARCHAR,
  job_external_ref        VARCHAR,            -- ServiceTrade job id the link points to
  contact_id              VARCHAR,            -- ServiceTrade contact id (existing or created live)
  email                   VARCHAR,            -- confirmed recipient email
  status                  VARCHAR NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','sent','failed','skipped')),
  servicetrade_message_id VARCHAR,            -- id from POST /message response
  error                   TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_link_messages_company_idx ON service_link_messages (company_id);
CREATE INDEX IF NOT EXISTS service_link_messages_retell_idx  ON service_link_messages (retell_call_id);
CREATE INDEX IF NOT EXISTS service_link_messages_status_idx  ON service_link_messages (company_id, status);

-- ── 2. SERVICE_LINK todo type (mirror 059's drop/re-add) ────────────────────
ALTER TABLE todos DROP CONSTRAINT IF EXISTS todos_type_check;
ALTER TABLE todos ADD  CONSTRAINT todos_type_check
  CHECK (type IN ('NOT_PICKED','VOICEMAIL','ASKED_FOR_RESCHEDULE','ASKED_FOR_CANCELLATION','UNCONFIRMED','APPOINTMENT_NEEDED','MISSING_PHONE','SERVICE_OPPORTUNITY','SERVICE_LINK'));

-- ── 3. per-company toggle ───────────────────────────────────────────────────
ALTER TABLE call_settings
  ADD COLUMN IF NOT EXISTS service_link_enabled BOOLEAN NOT NULL DEFAULT false;
