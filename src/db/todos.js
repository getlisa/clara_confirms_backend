const db = require("./index");
const callAnalysisConfigsDb = require("./call-analysis-configs");

const TODO_TYPES = {
  NOT_PICKED: "NOT_PICKED",
  VOICEMAIL: "VOICEMAIL",
  ASKED_FOR_RESCHEDULE: "ASKED_FOR_RESCHEDULE",
  ASKED_FOR_CANCELLATION: "ASKED_FOR_CANCELLATION",
  UNCONFIRMED: "UNCONFIRMED",
  APPOINTMENT_NEEDED: "APPOINTMENT_NEEDED",
  MISSING_PHONE: "MISSING_PHONE",
  SERVICE_OPPORTUNITY: "SERVICE_OPPORTUNITY",
};

/**
 * Create a MISSING_PHONE todo when the scheduler can't place a call because the
 * customer or technician has no phone number. Idempotent: re-uses any existing
 * open todo for the same (company, type, job_id, subject_kind).
 */
async function createMissingPhone({ companyId, jobId, subjectKind, subjectName, callType, reason, metadata = {}, isTest = false }) {
  const existing = await db.query(
    `SELECT id FROM todos
     WHERE company_id = $1 AND type = 'MISSING_PHONE' AND status = 'open' AND is_test = $2
       AND metadata->>'job_id' = $3
       AND metadata->>'subject_kind' = $4
     LIMIT 1`,
    [companyId, isTest, String(jobId), subjectKind]
  );
  if (existing.rows.length > 0) return existing.rows[0];

  const fullMeta = {
    job_id: String(jobId),
    subject_kind: subjectKind,         // 'customer' | 'technician'
    subject_name: subjectName || null,
    call_type: callType || null,
    reason: reason || "Phone number not provided",
    ...metadata,
  };
  const r = await db.query(
    `INSERT INTO todos (company_id, type, priority, is_test, metadata, notes)
     VALUES ($1, 'MISSING_PHONE', 'high', $2, $3, $4) RETURNING *`,
    [companyId, isTest, JSON.stringify(fullMeta), fullMeta.reason]
  );
  const todo = r.rows[0];
  await db.query(
    `INSERT INTO todo_logs (todo_id, company_id, actor_type, event_type, change)
     VALUES ($1, $2, 'system', 'created', $3)`,
    [todo.id, companyId, JSON.stringify({ type: "MISSING_PHONE", priority: "high", subjectKind, jobId })]
  );
  return todo;
}

/**
 * Derive todo type(s) from post-call analysis outcome.
 * Returns an array — a single call can produce at most one todo.
 */
function deriveTodoType({ inVoicemail, disconnectionReason, appointmentConfirmed, rescheduleRequested, cancellationRequested, customerOutcome }) {
  if (inVoicemail || disconnectionReason === "voicemail_reached") return TODO_TYPES.VOICEMAIL;

  const NO_ANSWER = new Set(["dial_no_answer", "dial_busy", "dial_failed", "user_declined", "invalid_destination", "error_no_audio_received"]);
  if (NO_ANSWER.has(disconnectionReason)) return TODO_TYPES.NOT_PICKED;

  if (cancellationRequested) return TODO_TYPES.ASKED_FOR_CANCELLATION;
  if (rescheduleRequested)   return TODO_TYPES.ASKED_FOR_RESCHEDULE;

  // Agent indicated no appointment exists and customer had no time preference
  if (customerOutcome === "appointment_needed") return TODO_TYPES.APPOINTMENT_NEEDED;

  if (appointmentConfirmed === "yes") return null; // happy path — no todo needed
  return TODO_TYPES.UNCONFIRMED;
}

/**
 * Create a todo after a call ends.
 * Looks up the company's call_analysis_configs to get the configured priority
 * and to check whether this todo type is enabled at all.
 * Returns null (and creates nothing) if the company has disabled this todo type.
 */
async function create({ companyId, callId, type, metadata, isTest = false }) {
  // Look up company-configured priority + enabled flag
  const priorityMap = await callAnalysisConfigsDb.getPriorityMap(companyId);
  const cfg = priorityMap[type];
  const priority = cfg?.priority ?? "medium";
  const enabled  = cfg?.enabled ?? true;

  if (!enabled) return null; // company opted out of this todo type

  const result = await db.query(
    `INSERT INTO todos (company_id, call_id, type, priority, is_test, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [companyId, callId, type, priority, isTest, metadata ? JSON.stringify(metadata) : null]
  );
  const todo = result.rows[0];

  await db.query(
    `INSERT INTO todo_logs (todo_id, company_id, actor_type, event_type, change)
     VALUES ($1, $2, 'system', 'created', $3)`,
    [todo.id, companyId, JSON.stringify({ type, priority })]
  );

  return todo;
}

async function list(companyId, { status, type, assignedTo, limit = 50, offset = 0, isTest = false } = {}) {
  const conditions = ["t.company_id = $1", "t.is_test = $2"];
  const values = [companyId, isTest];
  let i = 3;

  if (status) { conditions.push(`t.status = $${i++}`); values.push(status); }
  if (type) { conditions.push(`t.type = $${i++}`); values.push(type); }
  if (assignedTo) { conditions.push(`t.assigned_to = $${i++}`); values.push(assignedTo); }

  values.push(limit, offset);

  const result = await db.query(
    `SELECT t.*,
            u.first_name || ' ' || u.last_name AS assigned_to_name,
            c.retell_call_id, c.to_number, c.duration_ms, c.appointment_confirmed,
            c.reschedule_requested, c.cancellation_requested, c.call_summary,
            cu.id          AS customer_id,
            cu.full_name   AS customer_name,
            cu.email       AS customer_email,
            cu.address_line1, cu.city, cu.state, cu.zipcode,
            sc.call_type, sc.job_id, sc.job_name, sc.appointment_id
     FROM todos t
     LEFT JOIN users u ON u.id = t.assigned_to
     LEFT JOIN calls c ON c.id = t.call_id
     LEFT JOIN customers cu ON cu.company_id = t.company_id AND cu.phone = c.to_number
     LEFT JOIN scheduled_calls sc ON sc.retell_call_id = c.retell_call_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY
       CASE t.priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       t.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    values
  );
  return result.rows.map(rowToTodo);
}

function rowToTodo(row) {
  const customerAddress = [row.address_line1, row.city, row.state, row.zipcode].filter(Boolean).join(", ") || null;
  // Pull joined fields out so the base `todo` object stays clean
  const {
    customer_id, customer_name, customer_email,
    address_line1, city, state, zipcode,
    call_type, job_id, job_name, appointment_id,
    ...todoBase
  } = row;

  return {
    ...todoBase,
    customer: customer_id ? {
      id:      customer_id,
      name:    customer_name,
      phone:   row.to_number,
      email:   customer_email,
      address: customerAddress,
    } : null,
    call_type:      call_type ?? null,
    job_id:         job_id ?? null,
    job_name:       job_name ?? null,
    appointment_id: appointment_id ?? null,
  };
}

async function updateStatus(todoId, companyId, { status, notes, actorId }) {
  const result = await db.query(
    `UPDATE todos SET status = $1::varchar, notes = COALESCE($2, notes),
       resolved_at = CASE WHEN $1::varchar IN ('resolved','dismissed') THEN NOW() ELSE resolved_at END,
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

module.exports = { TODO_TYPES, deriveTodoType, create, createMissingPhone, list, updateStatus, assign, getLogs };
