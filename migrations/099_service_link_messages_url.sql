-- The customer-facing service-link URL, minted once at send time (via
-- ServiceTrade's /token endpoint, contactId-based) and persisted here so the
-- appointment card can show/link to it without re-minting on every fetch.
-- NULL until a send actually succeeds (or for any row from before this
-- column existed).
ALTER TABLE service_link_messages ADD COLUMN IF NOT EXISTS url TEXT NULL;
