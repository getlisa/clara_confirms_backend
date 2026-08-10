-- ServiceTrade's real per-job comment stream.
--
-- These come from `GET /comment?entityType=3&entityId=<servicetrade_job_id>`,
-- NOT from /job/{id} — that endpoint's `notes[]`/`schedulingComments[]` are
-- routinely empty even on jobs with a full comment history (verified live),
-- which is why confirmation inference reading only those came back mostly
-- "unclear". entityType 3 = Job, per servicetrade_entity_type_config.
--
-- ServiceTrade's own `created` timestamp is preserved as `commented_at` —
-- comment ordering/recency is what distinguishes "customer confirmed" from a
-- later "customer called to reschedule", so it can't be derived from our own
-- row timestamps (which move on every sync).

CREATE TABLE servicetrade_job_comments (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  servicetrade_id TEXT NOT NULL,
  servicetrade_job_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, servicetrade_id)
);

CREATE INDEX servicetrade_job_comments_job_idx
  ON servicetrade_job_comments (company_id, servicetrade_job_id);

CREATE TABLE job_comments (
  id BIGSERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  content TEXT,
  author_name TEXT,
  author_email TEXT,
  author_is_tech BOOLEAN,
  commented_at TIMESTAMPTZ,   -- ServiceTrade's `created` (unix → timestamptz)
  st_updated_at TIMESTAMPTZ,  -- ServiceTrade's `updated`
  pinned BOOLEAN NOT NULL DEFAULT false,
  visibility TEXT[],
  external_ref TEXT,
  source TEXT NOT NULL DEFAULT 'servicetrade',
  additional_information JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX job_comments_job_idx ON job_comments (company_id, job_id, commented_at DESC);

-- Required by db.bulkUpsertByExternalRef's ON CONFLICT target.
CREATE UNIQUE INDEX job_comments_external_uniq
  ON job_comments (company_id, external_ref, source) WHERE external_ref IS NOT NULL;
