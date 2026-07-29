-- scheduled_calls.phone_number was NOT NULL, which made sense when every
-- dispatch was voice/SMS — but a web_chat confirmation (email-only delivery)
-- has no phone requirement at all, and some real customers genuinely have no
-- phone on file (2400+ in production). Relax it; the concurrency/dedup logic
-- in claimPending already tolerates NULL correctly at the SQL level (NULL =
-- NULL is never true), and the JS-level per-batch dedup was fixed alongside
-- this migration to stop treating multiple NULL-phone rows as duplicates of
-- each other.
ALTER TABLE scheduled_calls ALTER COLUMN phone_number DROP NOT NULL;
