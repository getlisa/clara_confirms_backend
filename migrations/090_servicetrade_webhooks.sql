-- ServiceTrade webhooks — push notifications instead of waiting for the hourly poll.
--
-- The existing /admin/crm-sync cron stays exactly as it is; this runs alongside
-- it so a change made inside that hour shows up in seconds instead of at the
-- next poll. Webhooks cannot replace it: ServiceRequest is NOT a webhookable
-- entity (verified against the live spec — the supported list is Appointment,
-- Attachment, ClockEvent, Company, Contact, Deficiency, Invoice, Job, JobItem,
-- Location, Quote, QuoteItem, User), and service_opportunities are built
-- entirely on /servicerequest. A message is also discarded permanently after 3
-- failed delivery attempts, so the poll remains the correctness backstop.
--
-- Two tables: who we are subscribed as, and what has arrived but not yet been
-- applied.
--
-- ── Why the queue exists at all ────────────────────────────────────────────
-- ServiceTrade allows 5 SECONDS to respond, retries 3 times, then discards the
-- message forever. Applying an event means GET /job/{id}, GET /appointment?
-- jobId=, the customer record, the contact roster, then writes and normalize —
-- far more than 5s. So the receiving endpoint does exactly one INSERT and
-- returns 200; a drain applies the events afterwards.
--
-- ── Why a secret column and not a signature ────────────────────────────────
-- ServiceTrade sends NO signature, NO HMAC, NO shared secret and NO auth
-- header — verified against the full published spec. The only channel
-- available for authenticating an inbound message is the hookUrl itself, so
-- each company gets an unguessable secret embedded in its URL, looked up here.
-- That is weak, and deliberately so: the payload carries only entity ids, so
-- the worst a forged message can do is make us re-fetch a real entity from
-- ServiceTrade with our own credentials. It cannot inject data.

CREATE TABLE IF NOT EXISTS servicetrade_webhook_subscriptions (
  company_id            INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  -- The unguessable path segment in hookUrl. Unique so the inbound lookup is
  -- secret -> company with no ambiguity.
  secret                TEXT NOT NULL UNIQUE,
  -- ServiceTrade's own id for the subscription, so we can PUT/DELETE it later.
  -- Null while we have generated a secret but not yet registered upstream.
  servicetrade_webhook_id BIGINT,
  hook_url              TEXT,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  -- ServiceTrade's `confirmed` flag, mirrored for display only. It is NOT
  -- evidence the endpoint works: a subscription created against
  -- https://example.invalid — a domain that cannot resolve — reported
  -- confirmed:false on POST and confirmed:true on the GET one second later.
  -- Only an observed delivery proves reachability.
  confirmed             BOOLEAN NOT NULL DEFAULT FALSE,
  entity_events         JSONB,
  -- Populated by the receiver, so "is this thing actually live?" is answerable
  -- without trusting `confirmed`.
  last_message_at       TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS servicetrade_webhook_events (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- ServiceTrade's messageId. One message carries a `data` ARRAY of entities,
  -- so this is NOT unique on its own — each element becomes its own row.
  message_id    TEXT NOT NULL,
  action        TEXT NOT NULL,     -- created | updated | deleted
  entity_type   TEXT NOT NULL,     -- job | appointment | contact | location | company | user | …
  entity_id     BIGINT NOT NULL,
  entity_uri    TEXT,
  -- data[].timestamp, the moment the change happened. Messages may arrive out
  -- of order, so this — not received_at — is the authority on sequence.
  event_ts      TIMESTAMPTZ,
  -- data[].userId: null when a system process made the change rather than a person.
  actor_user_id BIGINT,
  -- Only present on `updated` when includeChangesets is on. Tracked fields are
  -- narrow but happen to be exactly our domain: Appointment status/windowStart/
  -- windowEnd and Job status.
  changeset     JSONB,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','processing','done','failed','skipped')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  -- Which job we resolved this event to; the targeted sync works per job id.
  resolved_job_ref TEXT,
  last_error    TEXT,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at    TIMESTAMPTZ,
  processed_at  TIMESTAMPTZ
);

-- Idempotency. The spec warns messages may be delivered "even more than once",
-- and a retry re-sends the identical messageId with the identical data array.
-- Keyed on the whole identity of one data element rather than message_id alone,
-- because one message legitimately contains many entities.
CREATE UNIQUE INDEX IF NOT EXISTS servicetrade_webhook_events_dedupe_uq
  ON servicetrade_webhook_events (company_id, message_id, entity_type, entity_id, action);

-- The drain's only read pattern: oldest pending first. Partial, so the index
-- stays small as processed rows accumulate.
CREATE INDEX IF NOT EXISTS servicetrade_webhook_events_pending_idx
  ON servicetrade_webhook_events (company_id, received_at)
  WHERE status IN ('pending','processing');

-- For the retention sweep and for answering "what happened to job X".
CREATE INDEX IF NOT EXISTS servicetrade_webhook_events_processed_idx
  ON servicetrade_webhook_events (processed_at)
  WHERE processed_at IS NOT NULL;
