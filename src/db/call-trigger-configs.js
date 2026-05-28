const db = require("./index");

const TRIGGER_TYPES = [
  "scheduled_unconfirmed",
  "quotation_pending",
  "open_job_due_soon",
  "technician_unconfirmed",
];

const BUILTIN_SEEDS = [
  {
    trigger_type:   "scheduled_unconfirmed",
    enabled:        false,
    call_type:      "customer_confirmation",
    days_before:    2,
    trigger_config: { retry_if_no_answer: true },
    description:    "Call customer to confirm their upcoming appointment when job is scheduled but unconfirmed.",
  },
  {
    trigger_type:   "quotation_pending",
    enabled:        false,
    call_type:      "quotation_followup",
    days_before:    3,
    trigger_config: { quote_statuses: ["sent", "viewed"], days_after_sent: 3 },
    description:    "Follow up with customer on a sent or viewed quotation that hasn't been accepted yet.",
  },
  {
    trigger_type:   "open_job_due_soon",
    enabled:        false,
    call_type:      "customer_confirmation",
    days_before:    7,
    trigger_config: { only_if_technician_assigned: false },
    description:    "Call customer when an open (unscheduled) job is approaching its expected date.",
  },
  {
    trigger_type:   "technician_unconfirmed",
    enabled:        false,
    call_type:      "technician_confirmation",
    days_before:    1,
    trigger_config: {},
    description:    "Call the assigned technician when a job is scheduled and they haven't confirmed availability yet.",
  },
];

function rowToObject(row) {
  return {
    trigger_type:   row.trigger_type,
    enabled:        row.enabled,
    call_type:      row.call_type,
    days_before:    Number(row.days_before),
    trigger_config: row.trigger_config ?? {},
    description:    row.description ?? null,
    updated_at:     row.updated_at,
  };
}

/**
 * Seed all three built-in triggers for a new company.
 * Idempotent — uses ON CONFLICT DO NOTHING.
 */
async function seedBuiltins(companyId, client) {
  const run = client ?? db;
  for (const seed of BUILTIN_SEEDS) {
    await run.query(
      `INSERT INTO call_trigger_configs
         (company_id, trigger_type, enabled, call_type, days_before, trigger_config, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (company_id, trigger_type) DO NOTHING`,
      [
        companyId,
        seed.trigger_type,
        seed.enabled,
        seed.call_type,
        seed.days_before,
        JSON.stringify(seed.trigger_config),
        seed.description,
      ]
    );
  }
}

async function getAllByCompanyId(companyId) {
  const result = await db.query(
    `SELECT trigger_type, enabled, call_type, days_before, trigger_config, description, updated_at
     FROM call_trigger_configs
     WHERE company_id = $1
     ORDER BY CASE trigger_type
       WHEN 'scheduled_unconfirmed' THEN 1
       WHEN 'quotation_pending'     THEN 2
       WHEN 'open_job_due_soon'     THEN 3
       ELSE 4 END`,
    [companyId]
  );

  // Fill in any missing triggers with defaults (if seeding was missed)
  const saved = Object.fromEntries(result.rows.map((r) => [r.trigger_type, rowToObject(r)]));
  return TRIGGER_TYPES.map((t) => saved[t] ?? {
    trigger_type: t,
    ...BUILTIN_SEEDS.find((s) => s.trigger_type === t),
  });
}

async function getEnabledByCompanyId(companyId) {
  const result = await db.query(
    `SELECT trigger_type, enabled, call_type, days_before, trigger_config, description
     FROM call_trigger_configs
     WHERE company_id = $1 AND enabled = true`,
    [companyId]
  );
  return result.rows.map(rowToObject);
}

async function upsert(companyId, triggerType, fields) {
  if (!TRIGGER_TYPES.includes(triggerType)) {
    const err = new Error(`Invalid trigger_type: ${triggerType}`);
    err.status = 400;
    throw err;
  }

  const allowed = ["enabled", "call_type", "days_before", "trigger_config"];
  const provided = Object.keys(fields).filter((k) => allowed.includes(k));
  if (provided.length === 0) return getAllByCompanyId(companyId);

  // Get seed defaults for this type (for ON CONFLICT insert)
  const seed = BUILTIN_SEEDS.find((s) => s.trigger_type === triggerType);

  const result = await db.query(
    `INSERT INTO call_trigger_configs
       (company_id, trigger_type, enabled, call_type, days_before, trigger_config, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (company_id, trigger_type) DO UPDATE SET
       ${provided.map((k, i) => `${k} = $${i + 8}`).join(", ")},
       updated_at = NOW()
     RETURNING trigger_type, enabled, call_type, days_before, trigger_config, description, updated_at`,
    [
      companyId,
      triggerType,
      seed.enabled,
      seed.call_type,
      seed.days_before,
      JSON.stringify(seed.trigger_config),
      seed.description,
      ...provided.map((k) =>
        k === "trigger_config" ? JSON.stringify(fields[k]) : fields[k]
      ),
    ]
  );
  return rowToObject(result.rows[0]);
}

module.exports = { TRIGGER_TYPES, BUILTIN_SEEDS, seedBuiltins, getAllByCompanyId, getEnabledByCompanyId, upsert };
