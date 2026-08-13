-- Snapshot WHO we shared a chat link with, on the link itself.
--
-- Today chat_links records only recipient_contact_id, and the agent re-resolves
-- the name from `contacts` at conversation time. That leaves two holes:
--
--   1. recipient_contact_id is NULL whenever the link went to the customer's own
--      details (the common case: 9 of 10 live links). The agent then falls back
--      to customers.full_name for the greeting — and in this data model that is
--      never a person. All 138 customers across companies 8 and 9 have
--      first_name/last_name NULL; full_name holds "JACK LTR", "Holiday Inn
--      Express-NE City", "123 California Ave". On 72 of 215 jobs it is byte-for-byte
--      the LOCATION name, so the prompt simultaneously said
--      '"X" is a LOCATION NAME — never address it as a person' and
--      'You are texting X.'
--   2. Re-resolving by id means a renamed or deleted contact silently changes or
--      loses the name we actually addressed the email/SMS to.
--
-- Stamped at SEND (next to sent_at/origin), not at creation: a link is reused
-- across re-sends, and the answer to "who did we share this with" is whoever the
-- last delivery was addressed to. A link a staff member copied by hand is never
-- sent to anyone, so it correctly keeps NULL here.
--
-- recipient_name is a PERSON's name or nothing — it is only ever populated from
-- a contacts row. Never fill it from customers.full_name.

ALTER TABLE chat_links
  ADD COLUMN IF NOT EXISTS recipient_name  TEXT,
  ADD COLUMN IF NOT EXISTS recipient_email TEXT,
  ADD COLUMN IF NOT EXISTS recipient_phone TEXT;
