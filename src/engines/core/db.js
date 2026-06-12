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
    `SELECT id, kind, current_state, status, result, error, started_at, finished_at,
            last_event_seq
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

module.exports = {
  createRun, getRun, appendEvent, setStatus, getEventsSince, listRuns, gcOldRuns,
};
