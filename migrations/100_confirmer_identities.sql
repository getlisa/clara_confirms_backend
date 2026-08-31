-- Who is actually confirming, captured once per chat session and reused for
-- every subsequent confirm/reschedule/cancel/create in that conversation —
-- the model-driven or frontend-driven capture point calls
-- capture_confirmer_identity once; every handler then reads it back via
-- confirmation-agent/index.js's resolveConfirmedBy, the same
-- resolve-fresh-every-turn shape as chat_links.recipient_* / resolveRecipient.
CREATE TABLE IF NOT EXISTS confirmer_identities (
  id BIGSERIAL PRIMARY KEY,
  chat_link_token TEXT NOT NULL UNIQUE REFERENCES chat_links(token) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('management', 'on_site', 'billing', 'scheduling', 'owner', 'other')),
  email TEXT,
  phone TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
