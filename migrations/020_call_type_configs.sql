CREATE TABLE call_type_configs (
  id             SERIAL PRIMARY KEY,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type           VARCHAR NOT NULL,
  name           VARCHAR NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  is_custom      BOOLEAN NOT NULL DEFAULT false,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  days_before    INTEGER NOT NULL DEFAULT 2 CHECK (days_before >= 1),
  begin_message  TEXT,
  general_prompt TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, type)
);

CREATE INDEX call_type_configs_company_id_idx ON call_type_configs (company_id);
