const db = require("./index");

const DEFAULTS = [
  {
    todo_type:   "NOT_PICKED",
    priority:    "medium",
    enabled:     true,
    description: "Customer did not pick up the call.",
  },
  {
    todo_type:   "VOICEMAIL",
    priority:    "medium",
    enabled:     true,
    description: "Call reached voicemail.",
  },
  {
    todo_type:   "ASKED_FOR_RESCHEDULE",
    priority:    "high",
    enabled:     true,
    description: "Customer asked to reschedule the appointment.",
  },
  {
    todo_type:   "ASKED_FOR_CANCELLATION",
    priority:    "high",
    enabled:     true,
    description: "Customer asked to cancel the job or appointment.",
  },
  {
    todo_type:   "UNCONFIRMED",
    priority:    "medium",
    enabled:     true,
    description: "Customer did not confirm the job or appointment.",
  },
  {
    todo_type:   "APPOINTMENT_NEEDED",
    priority:    "high",
    enabled:     true,
    description: "Customer has no active appointment and provided no time preference — team needs to book one.",
  },
];

async function seedDefaults(companyId, client) {
  const run = client ?? db;
  for (const d of DEFAULTS) {
    await run.query(
      `INSERT INTO call_analysis_configs
         (company_id, todo_type, priority, enabled, description)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (company_id, todo_type) DO NOTHING`,
      [companyId, d.todo_type, d.priority, d.enabled, d.description]
    );
  }
}

async function getByCompanyId(companyId) {
  const { rows } = await db.query(
    `SELECT todo_type, priority, enabled, description, updated_at
     FROM call_analysis_configs
     WHERE company_id = $1
     ORDER BY CASE todo_type
       WHEN 'ASKED_FOR_RESCHEDULE'   THEN 1
       WHEN 'ASKED_FOR_CANCELLATION' THEN 2
       WHEN 'NOT_PICKED'             THEN 3
       WHEN 'VOICEMAIL'              THEN 4
       WHEN 'UNCONFIRMED'            THEN 5
       ELSE 6 END`,
    [companyId]
  );

  // Fill in any missing rows with defaults (if seeding was missed)
  const saved = Object.fromEntries(rows.map(r => [r.todo_type, r]));
  return DEFAULTS.map(d => saved[d.todo_type] ?? d);
}

async function getPriorityMap(companyId) {
  const configs = await getByCompanyId(companyId);
  // Returns { todo_type: { priority, enabled } } for fast lookup
  return Object.fromEntries(configs.map(c => [c.todo_type, { priority: c.priority, enabled: c.enabled }]));
}

async function upsert(companyId, todoType, { priority, enabled }) {
  const valid = DEFAULTS.map(d => d.todo_type);
  if (!valid.includes(todoType)) {
    const err = new Error(`Invalid todo_type: ${todoType}`);
    err.status = 400;
    throw err;
  }

  const updates = [];
  const values = [companyId, todoType];
  let i = 3;
  if (priority !== undefined) { updates.push(`priority = $${i++}`); values.push(priority); }
  if (enabled  !== undefined) { updates.push(`enabled  = $${i++}`); values.push(enabled); }
  if (updates.length === 0) return getByCompanyId(companyId);

  // Ensure row exists first
  const def = DEFAULTS.find(d => d.todo_type === todoType);
  await db.query(
    `INSERT INTO call_analysis_configs (company_id, todo_type, priority, enabled, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (company_id, todo_type) DO NOTHING`,
    [companyId, def.todo_type, def.priority, def.enabled, def.description]
  );

  const { rows } = await db.query(
    `UPDATE call_analysis_configs
     SET ${updates.join(", ")}, updated_at = NOW()
     WHERE company_id = $1 AND todo_type = $2
     RETURNING todo_type, priority, enabled, description, updated_at`,
    values
  );
  return rows[0];
}

module.exports = { DEFAULTS, seedDefaults, getByCompanyId, getPriorityMap, upsert };
