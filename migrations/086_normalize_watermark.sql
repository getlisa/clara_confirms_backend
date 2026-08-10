-- Watermark for the normalize phase.
--
-- normalizeAll previously reprocessed a company's ENTIRE dataset on every run:
-- each pass read all raw rows and re-upserted all platform rows, so a sync
-- where two jobs changed still rewrote ~180 jobs, ~440 appointments, ~1,200
-- contacts and ~1,700 comments. On a remote-pooled connection (measured
-- ~17-34 kB/s upload) that dominates sync wall time.
--
-- Set only after a fully successful normalize, and to the timestamp captured
-- when that run STARTED — not NOW() at the end. Anything a concurrent sync
-- wrote while normalize was running therefore stays above the watermark and
-- gets picked up next run, instead of being skipped forever.
--
-- If normalize fails partway the watermark is left alone, so the next run
-- re-covers the same window. Every write in that path is an idempotent upsert,
-- so redoing work is safe; skipping it would not be.

ALTER TABLE servicetrade_sync_state
  ADD COLUMN IF NOT EXISTS last_normalized_at TIMESTAMPTZ;
