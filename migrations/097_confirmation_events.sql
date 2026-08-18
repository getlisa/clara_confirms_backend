-- An append-only ledger of confirmation OUTCOMES that actually succeeded.
--
-- This is the blocker the daily report exists to solve. Measured on live data:
-- appointments has 5,366 rows, 204 confirmed, but only 27 carry
-- additional_information->>'confirmed_by_thread_id', and there is NO
-- customer_confirmed_at column at all — nothing records WHEN a confirmation
-- happened. chat_links.state cannot substitute: report_customer_intent sets
-- 'confirmation_accepted' the instant the customer SAYS yes, before anything
-- reaches the CRM, and it stays set even if the write then fails (proven
-- earlier this month — chat links 69 and 70 both read confirmation_accepted;
-- only 69 actually confirmed anything). confirmation_agent_llm_logs.tool_calls
-- records attempts only, never results.
--
-- Same shape and same reasoning as chat_link_send_events (migration 093): the
-- data is unrecoverable after the fact, so it must be captured at the moment
-- it happens, not reconstructed later from other tables' side effects.
--
-- Written from the five chat tool handlers (confirm/reschedule/cancel/create,
-- immediately after the CRM call returns success — NOT from end_conversation,
-- so an outcome is captured even if the chat is abandoned right after) and
-- from the call_analyzed webhook handler for voice. Every write is
-- best-effort: a ledger failure must never fail the customer's confirmation.
--
-- Reports are only fully accurate for days after this ships. Voice history can
-- be backfilled from `calls` (it has real timestamps and outcomes); chat
-- history mostly cannot, and the report must say so rather than under-report
-- silently.

CREATE TABLE IF NOT EXISTS confirmation_events (
  id               SERIAL PRIMARY KEY,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type       TEXT NOT NULL CHECK (event_type IN ('confirmed', 'rescheduled', 'cancelled', 'created')),
  -- 'crm_sync' covers job-confirmation-inference.js: an appointment the
  -- CRM-synced job notes already show as confirmed (e.g. a CSR logged a
  -- phone call in ServiceTrade), auto-confirmed by an LLM read of those
  -- notes during the sync pipeline — a real, distinct confirmation source,
  -- not a subtype of voice or chat.
  channel          TEXT NOT NULL CHECK (channel IN ('voice', 'chat', 'crm_sync')),
  call_type        TEXT,                     -- e.g. customer_confirmation — lets the report scope out technician call types
  job_id           INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  appointment_id   INTEGER,                  -- ServiceTrade id, not a local FK — appointments are never persisted locally by id in a stable way
  customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  -- Who confirmed, in human terms — the recipient snapshot resolved at
  -- outreach time (chat_links.recipient_name / the send-events fallback), or
  -- the voice call's resolved contact. NOT a re-lookup at report time: the
  -- point is to record who it was WHEN it happened.
  actor_name       TEXT,
  -- chat_links.token for a chat outcome, calls.retell_call_id for voice — the
  -- audit trail back to the full conversation/transcript.
  source           TEXT,
  -- Reschedule: {"from": "...", "to": "..."}. Cancel: {"reason": "...", "scope": "visit"|"entire_job"}.
  details          JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_test          BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The report's read: one company, one business day.
CREATE INDEX IF NOT EXISTS confirmation_events_company_time_idx
  ON confirmation_events (company_id, occurred_at);
