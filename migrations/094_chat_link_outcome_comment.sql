-- When an EXPIRED chat had already produced an outcome, record that its CRM
-- comment was posted.
--
-- The gap this closes, observed on real data: chat link 69 (company 8) is
-- status='expired', state='confirmation_accepted', its appointment 110735 is
-- customer_confirmed=true — and there is no servicetrade_comment_posted row for
-- its token. The customer confirmed and then walked away from the chat, so
-- end_conversation never fired, so nothing reached the CRM. Comment write-back
-- is enabled for that company, so this was a silent miss rather than an
-- intentionally disabled feature.
--
-- Status deliberately STAYS 'expired': the link genuinely lapsed, and folding it
-- into 'ended' would understate lapses and hide that the customer never got a
-- proper close. This timestamp is what lets the UI say "expired — outcome
-- recorded", and it is the real idempotency guard for the sweep and the
-- one-off backfill (the marker check in servicetrade-comments.js fails OPEN on a
-- read error, so it cannot be the only protection).

ALTER TABLE chat_links
  ADD COLUMN IF NOT EXISTS outcome_comment_posted_at TIMESTAMPTZ;

-- The backfill/sweep read: expired links still owed a comment.
CREATE INDEX IF NOT EXISTS chat_links_outcome_comment_pending_idx
  ON chat_links (company_id)
  WHERE status = 'expired' AND outcome_comment_posted_at IS NULL;
