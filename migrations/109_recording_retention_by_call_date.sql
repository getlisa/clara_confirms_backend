-- Retention is measured from the CALL's date, not from when we archived it.
--
-- Migration 108 indexed `recording_archived_at`, matching a purge sweep that
-- expired recordings a fixed period after WE stored them. That turned out to be
-- the wrong key: backfilling an old call would resurrect audio the policy says
-- should already be gone — archive a five-month-old call today and it would be
-- held for another full window. With 125 of this database's voice calls already
-- older than the window, that was the common case rather than an edge one.
--
-- The sweep now orders and filters on `calls.created_at`, so the index follows
-- it. 108's index is dropped rather than left behind: it indexes a column the
-- purge no longer reads, and a partial index nothing queries is pure write
-- overhead on a hot table.
--
-- Nothing has been purged under the old rule (the window had not elapsed), so
-- there is no data to correct — only the index and the query.

DROP INDEX IF EXISTS calls_recording_archived_idx;

-- The purge sweep's read: archived audio, oldest CALL first.
CREATE INDEX IF NOT EXISTS calls_recording_retention_idx
  ON calls (created_at)
  WHERE recording_storage_path IS NOT NULL;
