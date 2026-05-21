const db = require("./index");

// Fields updatable by the user (representative_name only — prompts live on call_type_configs)
const USER_FIELDS = ["representative_name"];


function rowToObject(row) {
  return {
    representative_name: row.representative_name ?? null,
    subagent_count:      Number(row.subagent_count ?? 0),
  };
}

async function getByCompanyId(companyId) {
  const result = await db.query(
    `SELECT representative_name, subagent_count
     FROM agent_settings WHERE company_id = $1`,
    [companyId]
  );
  return result.rows[0]
    ? rowToObject(result.rows[0])
    : { representative_name: null, subagent_count: 0 };
}

/**
 * Upsert user-editable fields (representative_name).
 */
async function upsert(companyId, fields) {
  const provided = USER_FIELDS.filter((k) => k in fields);
  if (provided.length === 0) return getByCompanyId(companyId);

  const values = [companyId, ...provided.map((k) => fields[k])];
  const insertCols = provided.join(", ");
  const insertPlaceholders = provided.map((_, i) => `$${i + 2}`).join(", ");
  const setClauses = provided.map((k, i) => `${k} = $${i + 2}`).join(", ");

  const result = await db.query(
    `INSERT INTO agent_settings (company_id, ${insertCols})
     VALUES ($1, ${insertPlaceholders})
     ON CONFLICT (company_id) DO UPDATE SET
       ${setClauses},
       updated_at = NOW()
     RETURNING representative_name, retell_agent_id, retell_conversation_flow_id, subagent_count`,
    values
  );
  return rowToObject(result.rows[0]);
}

/**
 * Update Retell-managed fields after a flow sync.
 * Called by syncFlowForCompany — not exposed to the user.
 */
async function updateRetellIds(companyId, { retellAgentId, retellConversationFlowId, subagentCount }) {
  await db.query(
    `INSERT INTO agent_settings (company_id, retell_agent_id, retell_conversation_flow_id, subagent_count)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id) DO UPDATE SET
       retell_agent_id             = $2,
       retell_conversation_flow_id = $3,
       subagent_count              = $4,
       updated_at                  = NOW()`,
    [companyId, retellAgentId, retellConversationFlowId, subagentCount]
  );
}

module.exports = { getByCompanyId, upsert, updateRetellIds };
