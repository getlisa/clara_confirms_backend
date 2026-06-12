-- ─────────────────────────────────────────────────────────────────────────────
-- engine_runs — durable backing store for every workflow engine run.
--
-- Each engine (crm_sync, scheduler_run, ...) gets one row per execution.
-- `state_history` is an append-only JSONB array of events:
--     [{seq, ts, type, state, payload}, ...]
-- SSE clients reconnect with Last-Event-ID = seq → server replays events with
-- seq > N from the array, then tails live via the in-memory broker.
--
-- `status` is the terminal lifecycle marker; `current_state` is the engine's
-- own state-machine label (e.g. "fetching_jobs", "normalizing").
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE engine_runs (
  id              BIGSERIAL PRIMARY KEY,
  kind            VARCHAR(40) NOT NULL,
  company_id      INTEGER     NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  current_state   VARCHAR(50) NOT NULL DEFAULT 'started',
  state_history   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  last_event_seq  INTEGER     NOT NULL DEFAULT 0,
  status          VARCHAR(20) NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running','done','failed','cancelled')),
  result          JSONB,
  error           TEXT,
  started_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX engine_runs_company_kind_idx ON engine_runs (company_id, kind, started_at DESC);
CREATE INDEX engine_runs_status_idx       ON engine_runs (status) WHERE status = 'running';
CREATE INDEX engine_runs_started_at_idx   ON engine_runs (started_at);
