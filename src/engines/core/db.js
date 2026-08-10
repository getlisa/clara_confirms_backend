/**
 * engine_runs persistence layer. Append-only event history lives in
 * `state_history` JSONB. All reads/writes go through this module so the
 * Engine class never touches SQL directly.
 */

const db = require("../../db");

async function createRun({ kind, companyId, startedBy = null }) {
  const r = await db.query(
    `INSERT INTO engine_runs (kind, company_id, started_by)
     VALUES ($1, $2, $3) RETURNING *`,
    [kind, companyId, startedBy]
  );
  return r.rows[0];
}

async function getRun(runId, { companyId } = {}) {
  const params = companyId != null ? [runId, companyId] : [runId];
  const where = companyId != null ? "id = $1 AND company_id = $2" : "id = $1";
  const r = await db.query(`SELECT * FROM engine_runs WHERE ${where}`, params);
  return r.rows[0] || null;
}

/**
 * Append an event to state_history and return the new event with its seq.
 * Atomic: uses jsonb_array_length + jsonb_set so concurrent appenders don't
 * stomp each other's seq numbers (single-process today, but safer either way).
 */
async function appendEvent(runId, { type, state, payload }) {
  const r = await db.query(
    `UPDATE engine_runs
        SET last_event_seq = last_event_seq + 1,
            current_state  = COALESCE($2, current_state),
            state_history  = state_history || jsonb_build_array(
              jsonb_build_object(
                'seq',     last_event_seq + 1,
                'ts',      to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'type',    $3::text,
                'state',   COALESCE($2, current_state),
                'payload', $4::jsonb
              )
            )
      WHERE id = $1
      RETURNING last_event_seq, current_state`,
    [runId, state || null, type, JSON.stringify(payload || {})]
  );
  if (r.rows.length === 0) throw new Error(`engine_run ${runId} not found`);
  return {
    seq:     r.rows[0].last_event_seq,
    type,
    state:   r.rows[0].current_state,
    payload: payload || {},
    ts:      new Date().toISOString(),
  };
}

async function setStatus(runId, status, { result = null, error = null } = {}) {
  await db.query(
    `UPDATE engine_runs
        SET status = $2,
            result = $3::jsonb,
            error  = $4,
            finished_at = NOW()
      WHERE id = $1`,
    [runId, status, result ? JSON.stringify(result) : null, error]
  );
}

/**
 * Replay events with seq > sinceSeq. Used by SSE handler on reconnect.
 */
async function getEventsSince(runId, sinceSeq = 0) {
  const r = await db.query(
    `SELECT jsonb_array_elements(state_history) AS evt FROM engine_runs WHERE id = $1`,
    [runId]
  );
  return r.rows
    .map((row) => row.evt)
    .filter((e) => (e?.seq ?? 0) > sinceSeq);
}

async function listRuns({ companyId, kind, limit = 20 }) {
  const params = [companyId];
  let where = "company_id = $1";
  if (kind) { params.push(kind); where += ` AND kind = $${params.length}`; }
  params.push(limit);
  const r = await db.query(
    // last_event_at is the `ts` of the most recent state_history entry — the
    // run's heartbeat, used to tell a slow run from a dead one. Computed here
    // rather than returning state_history, which is an unbounded JSONB array
    // (hundreds of events on a real sync) and would make every status poll
    // ship it. `-> -1` is the last element; NULL for a run with no events yet.
    `SELECT id, kind, current_state, status, result, error, started_at, finished_at,
            last_event_seq,
            (state_history -> -1 ->> 'ts') AS last_event_at
       FROM engine_runs
      WHERE ${where}
      ORDER BY started_at DESC
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

/**
 * GC runs older than `days` days. Returns count deleted.
 */
async function gcOldRuns(days = 30) {
  const r = await db.query(
    `DELETE FROM engine_runs WHERE started_at < NOW() - ($1 || ' days')::interval
       AND status != 'running'`,
    [String(days)]
  );
  return r.rowCount;
}

/**
 * Mark abandoned runs as failed. A run is abandoned when the process died
 * without ever calling setStatus — on Vercel the function is frozen once its
 * HTTP response is sent, so any work still in flight (crm_sync deliberately
 * runs un-awaited) simply stops, leaving `running` in the table forever.
 *
 * gcOldRuns can't help: it excludes `status != 'running'` on purpose, so these
 * rows are never even deleted. Left alone they make status reporting lie
 * indefinitely — this account had runs claiming to be "running" for 31 and 60
 * days.
 *
 * `minutes` is deliberately generous. A legitimate run can be long: Vercel now
 * allows 300s, and the same code run locally has no cap at all and has taken
 * 10+ minutes on a full sync. The point is to catch corpses, not to impose a
 * deadline on live work.
 */
async function reapStaleRuns(minutes = 30) {
  const r = await db.query(
    `UPDATE engine_runs
        SET status = 'failed',
            error = COALESCE(error, 'Abandoned — no completion recorded within ' || $1 || ' minutes (process most likely terminated mid-run)'),
            finished_at = NOW()
      WHERE status = 'running'
        -- Silence, not age, is what identifies a dead run. Keying off
        -- started_at alone would reap a healthy long sync (a cold company
        -- measures ~9-10 min) that is still emitting events. Fall back to
        -- started_at only when a run never recorded an event at all.
        AND COALESCE((state_history -> -1 ->> 'ts')::timestamptz, started_at)
              < NOW() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(minutes)]
  );
  return r.rowCount;
}

module.exports = {
  createRun, getRun, appendEvent, setStatus, getEventsSince, listRuns, gcOldRuns, reapStaleRuns,
};
