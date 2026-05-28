CREATE TABLE IF NOT EXISTS call_analysis_configs (
  id          SERIAL PRIMARY KEY,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  todo_type   VARCHAR NOT NULL
              CHECK (todo_type IN ('NOT_PICKED','VOICEMAIL','ASKED_FOR_RESCHEDULE','ASKED_FOR_CANCELLATION','UNCONFIRMED')),
  priority    VARCHAR NOT NULL DEFAULT 'medium'
              CHECK (priority IN ('high','medium','low')),
  enabled     BOOLEAN NOT NULL DEFAULT true,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, todo_type)
);
