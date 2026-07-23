-- Shareable chat links: an opaque token that resolves to a specific job or
-- appointment's context, powering a web chat-widget page (separate from the
-- voice/SMS channels — this is a third, link-based way to reach the same
-- conversation flow, not part of the automatic channel-strategy resolver).
-- See chat-link-widget-frontend.md for the frontend contract.

CREATE TABLE IF NOT EXISTS chat_links (
  id              SERIAL PRIMARY KEY,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token           VARCHAR NOT NULL UNIQUE,
  job_id          INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  appointment_id  INTEGER REFERENCES appointments(id) ON DELETE CASCADE,
  call_type       VARCHAR NOT NULL DEFAULT 'customer_confirmation',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_opened_at  TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  CHECK (job_id IS NOT NULL OR appointment_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS chat_links_token_idx ON chat_links (token);
CREATE INDEX IF NOT EXISTS chat_links_appointment_idx ON chat_links (company_id, appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_links_job_idx ON chat_links (company_id, job_id) WHERE appointment_id IS NULL;
