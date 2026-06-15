const { z } = require("zod");
const db = require("../../../../db");
const logger = require("../../../../utils/logger");

const schema = z.object({
  name: z.string().min(1).describe("The customer name to look up. May contain typos or be partial."),
});

async function run({ name }, config) {
  const companyId = config?.configurable?.ctx?.companyId;

  let rows;
  try {
    // pg_trgm fuzzy match (preferred). `%` is the similarity operator.
    const r = await db.query(
      `SELECT id, full_name, phone, email, similarity(full_name, $2) AS score
       FROM customers
       WHERE company_id = $1 AND full_name IS NOT NULL
         AND (full_name % $2 OR full_name ILIKE '%' || $2 || '%')
       ORDER BY score DESC NULLS LAST
       LIMIT 5`,
      [companyId, name]
    );
    rows = r.rows;
  } catch (err) {
    // pg_trgm unavailable — fall back to plain ILIKE.
    logger.warn("find_customer: trigram query failed, falling back to ILIKE", { error: err.message });
    const r = await db.query(
      `SELECT id, full_name, phone, email
       FROM customers
       WHERE company_id = $1 AND full_name ILIKE '%' || $2 || '%'
       ORDER BY full_name ASC
       LIMIT 5`,
      [companyId, name]
    );
    rows = r.rows.map((x) => ({ ...x, score: null }));
  }

  if (rows.length === 0) {
    return JSON.stringify({ status: "not_found", query: name });
  }

  const top = rows[0];
  const second = rows[1];
  // A confident single match: high similarity and clearly ahead of the runner-up
  // (or only one candidate). When scores are unavailable (ILIKE fallback), treat
  // a single row as resolved, multiple as ambiguous.
  const clearLeader =
    top.score == null
      ? rows.length === 1
      : top.score >= 0.55 && (!second || top.score - (second.score || 0) > 0.2);

  return JSON.stringify({
    status: clearLeader ? "resolved" : "ambiguous",
    candidates: rows.map((r) => ({
      id: r.id,
      name: r.full_name,
      phone: r.phone,
      email: r.email,
      score: r.score != null ? Number(Number(r.score).toFixed(3)) : null,
    })),
  });
}

module.exports = {
  name: "find_customer",
  description:
    "Look up a customer by name (typo-tolerant fuzzy match), returning matching candidates with their ids. ALWAYS use this before answering questions or taking actions about a specific named customer. If the result status is 'ambiguous', ask the user to confirm which candidate they mean before continuing.",
  isWrite: false,
  schema,
  run,
};
