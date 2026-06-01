-- Queue priority lanes and retry chain tracking
ALTER TABLE scheduled_calls
  ADD COLUMN IF NOT EXISTS call_priority VARCHAR NOT NULL DEFAULT 'normal'
    CHECK (call_priority IN ('normal','retry','callback')),
  ADD COLUMN IF NOT EXISTS parent_call_id INTEGER REFERENCES scheduled_calls(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS callback_requested_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS scheduled_calls_priority_idx
  ON scheduled_calls (call_priority, scheduled_at)
  WHERE status = 'pending';
