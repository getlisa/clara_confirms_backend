CREATE TABLE agent_settings (
  id                       SERIAL PRIMARY KEY,
  company_id               INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  representative_name      VARCHAR,
  begin_message            TEXT,
  general_prompt           TEXT,
  days_before_confirmation INTEGER NOT NULL DEFAULT 2,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
