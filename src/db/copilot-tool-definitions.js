const db = require("./index");

/**
 * Set of enabled copilot tool names. The JS handler registry
 * (src/copilot/tools/registry.js) intersects its handlers with this set so a
 * tool can be turned off without a code change. Returns an empty set if the
 * table doesn't exist yet / hasn't been seeded — callers treat empty as
 * "no DB-level filtering, use all registered handlers".
 */
async function getEnabledNames() {
  const r = await db.query(
    `SELECT name FROM copilot_tool_definitions WHERE enabled = true`
  );
  return new Set(r.rows.map((row) => row.name));
}

async function getAll() {
  const r = await db.query(
    `SELECT * FROM copilot_tool_definitions ORDER BY sort_order ASC, name ASC`
  );
  return r.rows;
}

/** Upsert one tool definition (used by the seeder). */
async function upsert({ name, description, parameters, is_write_tool, sort_order }) {
  await db.query(
    `INSERT INTO copilot_tool_definitions (name, description, parameters, is_write_tool, sort_order)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO UPDATE SET
       description   = EXCLUDED.description,
       parameters    = EXCLUDED.parameters,
       is_write_tool = EXCLUDED.is_write_tool,
       sort_order    = EXCLUDED.sort_order,
       updated_at    = NOW()`,
    [name, description, JSON.stringify(parameters ?? {}), !!is_write_tool, sort_order ?? 0]
  );
}

module.exports = { getEnabledNames, getAll, upsert };
