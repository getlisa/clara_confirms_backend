/**
 * Junction-table write helpers shared across CRM providers. Pure SQL utilities
 * with no provider-specific knowledge — extracted from
 * crm/servicetrade/provider.js so a second provider (InspectPoint) reuses the
 * same correctness argument instead of hand-copying it.
 */

const db = require("../../../db");
const logger = require("../../../utils/logger");

async function bulkInsertJunction(table, colA, colB, pairs, { batchSize = 1000 } = {}) {
  if (!pairs.length) return;
  let queryCount = 0;
  for (let i = 0; i < pairs.length; i += batchSize) {
    const chunk = pairs.slice(i, i + batchSize);
    const values = [];
    const params = [];
    let idx = 0;
    for (const [a, b] of chunk) {
      values.push(`($${++idx}, $${++idx})`);
      params.push(a, b);
    }
    await db.query(
      `INSERT INTO ${table} (${colA}, ${colB}) VALUES ${values.join(", ")}
       ON CONFLICT (${colA}, ${colB}) DO NOTHING`,
      params
    );
    queryCount++;
  }
  logger.info("bulkInsertJunction: table upserted", { table, pairs: pairs.length, batchSize, queries: queryCount });
}

/**
 * Junction write with REPLACE-SET semantics, scoped to the parents this pass
 * actually looked at.
 *
 * bulkInsertJunction above can only ever ADD a link. Nothing deleted one, so a
 * link removed in the CRM survived every subsequent sync forever — verified on a
 * real account: a contact unlinked from a location in ServiceTrade stayed
 * attached in `contact_locations`, and would still have been sent that
 * location's confirmations. The raw table was correct the whole time; only the
 * normalized junction was stale. The hourly poll had this bug too — webhooks
 * only made it visible in a minute instead of an hour.
 *
 * @param parentIds EVERY parent this pass processed — NOT merely the parents
 *   appearing in `pairs`. This distinction is the whole correctness argument:
 *   a parent whose links were ALL removed contributes zero pairs, so deriving
 *   the scope from `pairs` would skip exactly the case that needs cleaning
 *   (the last contact removed from a location, the last technician unassigned
 *   from an appointment). Conversely the scope must never be "everything",
 *   because most callers are watermark-filtered — deleting outside the
 *   processed set would wipe live links for parents this pass never read.
 */
async function replaceJunction(table, colA, colB, pairs, parentIds, { batchSize = 1000 } = {}) {
  const parents = [...new Set(parentIds)].filter((id) => id != null);
  if (!parents.length) return;

  // Delete first, then insert: the pairs that survive are re-added by the
  // INSERT below, and every write here is idempotent, so a crash between the
  // two leaves rows to be restored by the next run rather than duplicated.
  const flatA = pairs.map(([a]) => a);
  const flatB = pairs.map(([, b]) => b);
  const { rowCount: removed } = await db.query(
    `DELETE FROM ${table} t
      WHERE t.${colA} = ANY($1::bigint[])
        AND NOT EXISTS (
          SELECT 1 FROM (SELECT unnest($2::bigint[]) AS a, unnest($3::bigint[]) AS b) v
           WHERE v.a = t.${colA} AND v.b = t.${colB}
        )`,
    [parents, flatA, flatB]
  );

  await bulkInsertJunction(table, colA, colB, pairs, { batchSize });

  if (removed > 0) {
    logger.info("replaceJunction: stale links removed", { table, removed, parents: parents.length, pairs: pairs.length });
  }
}

/**
 * Plain bulk INSERT (no upsert/conflict handling) for rows with no stable
 * external identity to key an upsert on — e.g. job/appointment notes, which
 * ServiceTrade never assigns an id to. Callers delete the prior rows for the
 * affected parents first, then re-insert, so this never needs ON CONFLICT.
 */
async function bulkInsertPlain(table, columns, rows, { batchSize = 1000 } = {}) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const values = [];
    const params = [];
    let idx = 0;
    for (const row of chunk) {
      values.push(`(${columns.map(() => `$${++idx}`).join(", ")})`);
      params.push(...columns.map((c) => row[c] ?? null));
    }
    await db.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values.join(", ")}`, params);
  }
}

module.exports = { bulkInsertJunction, replaceJunction, bulkInsertPlain };
