CREATE TABLE calls (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id),
  retell_call_id         VARCHAR NOT NULL UNIQUE,
  to_number              VARCHAR,
  from_number            VARCHAR,
  direction              VARCHAR NOT NULL DEFAULT 'outbound',
  status                 VARCHAR NOT NULL DEFAULT 'ended',   -- ended | analyzed
  duration_ms            INTEGER,
  disconnection_reason   VARCHAR,
  in_voicemail           BOOLEAN,

  -- Post-call analysis (populated on call_analyzed event)
  call_successful        BOOLEAN,
  call_summary           TEXT,
  user_sentiment         VARCHAR,                            -- Positive | Negative | Neutral | Unknown
  appointment_confirmed  VARCHAR,                            -- yes | no | unclear
  reschedule_requested   BOOLEAN,
  cancellation_requested BOOLEAN,
  -- Raw payloads
  metadata               JSONB,
  transcript             JSONB,
  raw_analysis           JSONB,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX calls_company_id_idx ON calls (company_id);
CREATE INDEX calls_retell_call_id_idx ON calls (retell_call_id);
