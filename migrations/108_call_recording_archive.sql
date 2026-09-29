-- Keep our OWN copy of each call recording, instead of only a pointer to Retell's.
--
-- Migration 107 captured `calls.recording_url` — Retell's URL. That made a
-- recording reviewable for the first time, but it left the durable copy in a
-- third party's bucket: if Retell expires the object or rotates the URL, the
-- recording CMAP-224 promises is reviewable quietly stops being reviewable.
-- Reviewability is the deliverable, so the bytes have to be ours.
--
-- Storage is the private Supabase bucket `call-recordings` (same project as
-- this database; the service-role key is already in config.supabase, so no new
-- vendor, credential or dependency). Object key:
--
--     <company_id>/<retell_call_id>/recording.<ext>
--
-- company_id leads so a company's audio can be located, counted or removed as
-- one prefix.

ALTER TABLE calls
  -- Object key within the bucket. NULL = we hold no copy.
  ADD COLUMN IF NOT EXISTS recording_storage_path   TEXT,
  ADD COLUMN IF NOT EXISTS recording_bytes          BIGINT,
  ADD COLUMN IF NOT EXISTS recording_content_type   TEXT,
  ADD COLUMN IF NOT EXISTS recording_archived_at    TIMESTAMPTZ,

  -- Retry bookkeeping for the archive sweep. Retell types recording_url as
  -- optional and its S3 object can lag the call_analyzed webhook, so the first
  -- attempt legitimately fails; these bound the retrying.
  ADD COLUMN IF NOT EXISTS recording_archive_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recording_archive_error    TEXT,

  -- Set when the retention sweep has DELIBERATELY deleted the object.
  --
  -- This column is load-bearing, not bookkeeping: without it, "we hold no copy"
  -- (storage_path IS NULL) is indistinguishable from "we deleted it on purpose",
  -- so the archive sweep would re-download every purged recording forever and
  -- silently defeat the retention policy it is supposed to enforce.
  ADD COLUMN IF NOT EXISTS recording_purged_at      TIMESTAMPTZ;

-- The archive sweep's read: voice calls that still need a copy. Deliberately
-- excludes anything already archived AND anything already purged.
CREATE INDEX IF NOT EXISTS calls_recording_archive_pending_idx
  ON calls (created_at)
  WHERE recording_storage_path IS NULL
    AND recording_purged_at IS NULL
    AND channel = 'voice';

-- The retention sweep's read: what we hold, oldest first.
CREATE INDEX IF NOT EXISTS calls_recording_archived_idx
  ON calls (recording_archived_at)
  WHERE recording_storage_path IS NOT NULL;
