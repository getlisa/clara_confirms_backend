-- The "confirm the rest?" step (bulk-confirm or explicit decline) leaves a
-- stamp here so POST /:token/end can refuse to close a conversation that
-- still has other unconfirmed appointments nobody has actually been asked
-- about yet. NULL means "not addressed" — the common case for a link with
-- only one appointment, where the gate never applies at all.
ALTER TABLE chat_links ADD COLUMN IF NOT EXISTS remaining_addressed_at TIMESTAMPTZ NULL;
