-- Short codes for masking the confirmation link in SMS.
--
-- A confirmation SMS carrying https://confirms.justclara.ai/chat/<48-hex> came
-- back UNDELIVERED with Twilio 30007 "Carrier violation". Controlled tests to
-- the same handset isolated it: the same sentence with no URL was delivered,
-- and the same sentence with https://youtube.com was delivered — so neither the
-- wording nor URLs as a category are the problem. The carrier is filtering our
-- domain by reputation.
--
-- Masking fixes it, and the tests showed why: a tinyurl.com link pointing at
-- our blocked domain was DELIVERED while a da.gd link pointing at the exact
-- same destination was blocked. The carrier does not follow the redirect — it
-- only judges the domain visible in the message body. That also rules out
-- giving ourselves a short domain: a new domain of ours would be another da.gd.
--
-- So we hand a third-party shortener a URL we control rather than the real
-- chat link. `short_code` backs GET /c/<code>, which 302s to the chat URL. The
-- shortener's permanent, public record then points at an opaque code we can
-- expire or revoke — the 48-hex token, which IS the auth credential for the
-- customer's conversation, never leaves our systems.
--
-- Both columns are nullable and filled lazily on the first SMS; links sent only
-- by email never get one. No new table — the code is derived per token, and
-- tokens already expire via chat_links.expires_at (24h), so cleanup rides
-- along. short_url caches the shortener's answer so a resend or a retry does
-- not call it again.

ALTER TABLE chat_links
  ADD COLUMN IF NOT EXISTS short_code TEXT,
  ADD COLUMN IF NOT EXISTS short_url  TEXT;

-- Partial: only one row may hold a given code, but the many rows with none
-- must not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS chat_links_short_code_uq
  ON chat_links (short_code) WHERE short_code IS NOT NULL;
