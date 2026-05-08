const db = require("./index");

const TODO_TYPES = {
  NOT_PICKED: "NOT_PICKED",
  VOICEMAIL: "VOICEMAIL",
  ASKED_FOR_RESCHEDULE: "ASKED_FOR_RESCHEDULE",
  ASKED_FOR_CANCELLATION: "ASKED_FOR_CANCELLATION",
  UNCONFIRMED: "UNCONFIRMED",
};

const PRIORITY_BY_TYPE = {
  NOT_PICKED: "medium",
  VOICEMAIL: "medium",
  ASKED_FOR_RESCHEDULE: "high",
  ASKED_FOR_CANCELLATION: "high",
  UNCONFIRMED: "medium",
};

/**
 * Derive todo type(s) from post-call analysis outcome.
 * Returns an array — a single call can produce at most one todo.
 */
function deriveTodoType({ inVoicemail, disconnectionReason, appointmentConfirmed, rescheduleRequested, cancellationRequested }) {
  if (inVoicemail || disconnectionReason === "voicemail_reached") return TODO_TYPES.VOICEMAIL;

  const NO_ANSWER = new Set(["dial_no_answer", "dial_busy", "dial_failed", "user_declined", "invalid_destination", "error_no_audio_received"]);
  if (NO_ANSWER.has(disconnectionReason)) return TODO_TYPES.NOT_PICKED;

  if (cancellationRequested) return TODO_TYPES.ASKED_FOR_CANCELLATION;
  if (rescheduleRequested) return TODO_TYPES.ASKED_FOR_RESCHEDULE;
  if (appointmentConfirmed === "yes") return null; // happy path — no todo needed
  return TODO_TYPES.UNCONFIRMED;
}

async function create({ companyId, callId, type, metadata }) {
  const priority = PRIORITY_BY_TYPE[type] || "medium";
  const result = await db.query(
    `INSERT INTO todos (company_id, call_id, type, priority, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [companyId, callId, type, priority, metadata ? JSON.stringify(metadata) : null]
  );
  const todo = result.rows[0];

  await db.query(
    `INSERT INTO todo_logs (todo_id, company_id, actor_type, event_type, change)
     VALUES ($1, $2, 'system', 'created', $3)`,
    [todo.id, companyId, JSON.stringify({ type, priority })]
  );

  return todo;
}

async function list(companyId, { status, type, assignedTo, limit = 50, offset = 0 } = {}) {
  const conditions = ["t.company_id = $1"];
  const values = [companyId];
  let i = 2;

  if (status) { conditions.push(`t.status = $${i++}`); values.push(status); }
  if (type) { conditions.push(`t.type = $${i++}`); values.push(type); }
  if (assignedTo) { conditions.push(`t.assigned_to = $${i++}`); values.push(assignedTo); }

  values.push(limit, offset);

  const result = await db.query(
    `SELECT t.*,
            u.first_name || ' ' || u.last_name AS assigned_to_name,
            c.retell_call_id, c.to_number, c.duration_ms, c.appointment_confirmed,
            c.reschedule_requested, c.cancellation_requested, c.call_summary
     FROM todos t
     LEFT JOIN users u ON u.id = t.assigned_to
     LEFT JOIN calls c ON c.id = t.call_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY
       CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       t.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return result.rows;
}

async function updateStatus(todoId, companyId, { status, notes, actorId }) {
  const result = await db.query(
    `UPDATE todos SET status = $1, notes = COALESCE($2, notes),
       resolved_at = CASE WHEN $1 IN ('resolved','dismissed') THEN NOW() ELSE resolved_at END,
       updated_at = NOW()
     WHERE id = $3 AND company_id = $4
     RETURNING *`,
    [status, notes || null, todoId, companyId]
  );
  const todo = result.rows[0];
  if (!todo) return null;

  await db.query(
    `INSERT INTO todo_logs (todo_id, company_id, actor_id, actor_type, event_type, change, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      todoId, companyId, actorId || null, actorId ? "user" : "system",
      status === "resolved" ? "resolved" : status === "dismissed" ? "dismissed" : "status_changed",
      JSON.stringify({ status }),
      notes || null,
    ]
  );

  return todo;
}

async function assign(todoId, companyId, { assignedTo, actorId }) {
  const result = await db.query(
    `UPDATE todos SET assigned_to = $1, status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
       updated_at = NOW()
     WHERE id = $2 AND company_id = $3
     RETURNING *`,
    [assignedTo, todoId, companyId]
  );
  const todo = result.rows[0];
  if (!todo) return null;

  await db.query(
    `INSERT INTO todo_logs (todo_id, company_id, actor_id, actor_type, event_type, change)
     VALUES ($1, $2, $3, 'user', 'assigned', $4)`,
    [todoId, companyId, actorId, JSON.stringify({ assigned_to: assignedTo })]
  );

  return todo;
}

async function getLogs(todoId, companyId) {
  const result = await db.query(
    `SELECT tl.*, u.first_name || ' ' || u.last_name AS actor_name
     FROM todo_logs tl
     LEFT JOIN users u ON u.id = tl.actor_id
     WHERE tl.todo_id = $1 AND tl.company_id = $2
     ORDER BY tl.created_at ASC`,
    [todoId, companyId]
  );
  return result.rows;
}

module.exports = { TODO_TYPES, deriveTodoType, create, list, updateStatus, assign, getLogs };
