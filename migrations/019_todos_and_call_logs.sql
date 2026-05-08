-- Todos (equivalent to escalations in collection_agent_backend)
CREATE TABLE todos (
  id           SERIAL PRIMARY KEY,
  company_id   INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  call_id      INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  type         VARCHAR(50) NOT NULL
                 CHECK (type IN ('NOT_PICKED','VOICEMAIL','ASKED_FOR_RESCHEDULE','ASKED_FOR_CANCELLATION','UNCONFIRMED')),
  status       VARCHAR(20) NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','in_progress','resolved','dismissed')),
  priority     VARCHAR(10) NOT NULL DEFAULT 'medium'
                 CHECK (priority IN ('high','medium','low')),
  assigned_to  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes        TEXT,
  metadata     JSONB,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX todos_company_status_idx  ON todos (company_id, status) WHERE status != 'resolved';
CREATE INDEX todos_call_id_idx         ON todos (call_id);
CREATE INDEX todos_assigned_to_idx     ON todos (assigned_to, status) WHERE status != 'resolved';

-- Audit trail for todo state changes
CREATE TABLE todo_logs (
  id          SERIAL PRIMARY KEY,
  todo_id     INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_type  VARCHAR(10) NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user','system')),
  event_type  VARCHAR(50) NOT NULL,   -- created | assigned | status_changed | resolved | dismissed
  change      JSONB,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX todo_logs_todo_id_idx    ON todo_logs (todo_id, created_at DESC);
CREATE INDEX todo_logs_company_id_idx ON todo_logs (company_id, created_at DESC);

-- Call event log (one row per webhook event per call)
CREATE TABLE call_logs (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id),
  call_id        INTEGER REFERENCES calls(id) ON DELETE SET NULL,
  retell_call_id VARCHAR NOT NULL,
  event_type     VARCHAR(50) NOT NULL,  -- call_ended | call_analyzed
  payload        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX call_logs_company_id_idx     ON call_logs (company_id, created_at DESC);
CREATE INDEX call_logs_call_id_idx        ON call_logs (call_id);
CREATE INDEX call_logs_retell_call_id_idx ON call_logs (retell_call_id);
