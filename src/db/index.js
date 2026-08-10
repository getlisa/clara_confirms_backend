const { Pool } = require("pg");
const config = require("../config");
const logger = require("../utils/logger");

// Server-side cancel must fire BEFORE the client gives up, otherwise the
// client abandons a query the backend is still executing. Both are also
// applied per-session in the pool's `connect` handler — see the note there.
const STATEMENT_TIMEOUT_MS = 30000;
const QUERY_TIMEOUT_MS     = 35000;

class Database {
  constructor() {
    const isServerless = process.env.VERCEL === "1";
    const isPgBouncer =
      process.env.DATABASE_URL?.includes("pgbouncer=true") ||
      process.env.DATABASE_URL?.includes(":6543");

    this.pool = new Pool({
      connectionString: config.database.url,
      min: isServerless ? 0 : config.database.poolMin,
      max: isServerless ? 2 : config.database.poolMax,
      idleTimeoutMillis: isPgBouncer ? 0 : 30000,
      connectionTimeoutMillis: isServerless ? 30000 : 15000,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      query_timeout: QUERY_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      ssl:
        process.env.DATABASE_URL?.includes("sslmode=require") ||
        process.env.DATABASE_URL?.includes("supabase")
          ? { rejectUnauthorized: false }
          : undefined,
    });

    logger.info("Database pool initialized", {
      isServerless,
      isPgBouncer,
      poolMin: isServerless ? 0 : config.database.poolMin,
      poolMax: isServerless ? 2 : config.database.poolMax,
    });

    this.pool.on("connect", (client) => {
      // `statement_timeout` passed as a Pool constructor option is sent as a
      // startup parameter, which Supabase's transaction-mode pooler (:6543)
      // silently drops — `SHOW statement_timeout` came back as the server
      // default (2min), so Postgres never cancelled a slow query and only the
      // client-side query_timeout fired ("Query read timeout"), leaving the
      // backend still working. Setting it per-session here actually applies,
      // so the server cancels first and the connection is reusable after.
      client
        .query(`SET timezone = 'UTC'; SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
        .catch((err) => {
          logger.warn("Failed to set session defaults on connection", {
            error: err.message,
          });
        });
    });

    this.pool.on("error", (err) => {
      logger.warn("Database pool error (connections will be recreated)", {
        error: err.message,
        code: err.code,
      });
    });
  }

  async query(text, params, retried = false) {
    const start = Date.now();
    try {
      const result = await this.pool.query(text, params);
      logger.debug("Executed query", {
        duration: `${Date.now() - start}ms`,
        rows: result.rowCount,
      });
      return result;
    } catch (error) {
      const isConnectionError =
        /connection terminated|ECONNRESET|ECONNREFUSED|connect ENOENT|Connection lost|ETIMEDOUT/i.test(
          error.message
        ) || error.code === "57P01" || error.code === "ETIMEDOUT";
      if (isConnectionError && !retried) {
        logger.warn("Database connection error, retrying once", {
          message: error.message,
        });
        return this.query(text, params, true);
      }
      const errorInfo = {
        message: error.message,
        code: error.code,
        detail: error.detail,
        query: text.replace(/\s+/g, " ").trim().substring(0, 150),
      };
      logger.error(
        "Database query failed",
        Object.fromEntries(
          Object.entries(errorInfo).filter(([, v]) => v !== undefined)
        )
      );
      throw error;
    }
  }

  async getClient() {
    return this.pool.connect();
  }

  /**
   * Bulk INSERT ... ON CONFLICT (company_id, external_ref, source) DO UPDATE,
   * chunked into batches. Replaces the N-row "SELECT to check existence, then
   * INSERT or UPDATE" pattern (2N sequential round trips) with a handful of
   * multi-row statements — needed once a synced entity reaches thousands of
   * rows, or the per-row version starts hitting the query timeout.
   *
   * Requires a partial UNIQUE index on (company_id, external_ref, source)
   * WHERE external_ref IS NOT NULL on the target table.
   *
   * @param {string} table
   * @param {Array<{column: string, key: string, jsonb?: boolean, transform?: (v:any)=>any, updateExpr?: string}>} fields
   *   `column` = DB column name, `key` = property name on each row object.
   *   `transform` applies before binding (e.g. default values). `updateExpr`
   *   overrides the ON CONFLICT UPDATE SET clause for that column (default
   *   `<column> = EXCLUDED.<column>`) — e.g. for COALESCE-don't-clobber semantics.
   * @param {Array<object>} rows — each needs companyId, externalRef, source, additionalInformation, plus `key`s above.
   * @returns {Promise<number>} rows processed
   */
  async bulkUpsertByExternalRef(table, fields, rows, { batchSize = 500 } = {}) {
    if (!rows.length) return 0;
    let queryCount = 0;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const values = [];
      const params = [];
      let idx = 0;
      for (const r of chunk) {
        const placeholders = [];
        idx++; placeholders.push(`$${idx}`); params.push(r.companyId);
        for (const f of fields) {
          idx++;
          placeholders.push(f.jsonb ? `$${idx}::jsonb` : `$${idx}`);
          let v = r[f.key];
          if (f.transform) v = f.transform(v);
          params.push(f.jsonb ? JSON.stringify(v ?? null) : (v === undefined ? null : v));
        }
        idx++; placeholders.push(`$${idx}`); params.push(r.externalRef);
        idx++; placeholders.push(`$${idx}`); params.push(r.source);
        idx++; placeholders.push(`$${idx}::jsonb`); params.push(JSON.stringify(r.additionalInformation || {}));
        values.push(`(${placeholders.join(", ")})`);
      }
      const cols = ["company_id", ...fields.map((f) => f.column), "external_ref", "source", "additional_information"];
      const updateSet = fields
        .map((f) => f.updateExpr || `${f.column} = EXCLUDED.${f.column}`)
        .concat(["additional_information = EXCLUDED.additional_information", "updated_at = NOW()"])
        .join(", ");
      // The target index is partial (WHERE external_ref IS NOT NULL) — Postgres
      // only matches an ON CONFLICT arbiter to a partial index if the same
      // predicate is repeated here, otherwise it fails with 42P10 ("no unique
      // or exclusion constraint matching"). Every row through this path always
      // has an externalRef, so the predicate is always satisfied in practice.
      await this.query(
        `INSERT INTO ${table} (${cols.join(", ")})
         VALUES ${values.join(", ")}
         ON CONFLICT (company_id, external_ref, source) WHERE external_ref IS NOT NULL
         DO UPDATE SET ${updateSet}`,
        params
      );
      queryCount++;
    }
    logger.info("bulkUpsertByExternalRef: table upserted", { table, rows: rows.length, batchSize, queries: queryCount });
    return rows.length;
  }

  /**
   * Fetch every row of a company's rows from `table` via keyset pagination on
   * the primary key, returning them all as one array.
   *
   * Needed for tables carrying a large TOASTed `payload` JSONB (the
   * servicetrade_* raw mirrors): a single unbounded SELECT has to stream
   * multiple MB in one round trip, which on a remote pooled connection is
   * slow and erratic enough to blow past query_timeout — measured on the same
   * 843 kB / 207-row query at 2.7s, 4.4s, 11.5s and one outright timeout,
   * with the database completely idle each time (server-side execution:
   * 0.16ms). Chunking keeps every individual round trip small and bounded, so
   * a slow link degrades throughput instead of failing the whole sync.
   *
   * Keyset (`id > lastId`) rather than OFFSET — OFFSET re-scans and re-sorts
   * the skipped rows on every page.
   *
   * @param {number|string} companyId
   * @param {string} table
   * @param {object} [opts]
   * @param {string} [opts.columns="*"] — column list; keep `id` in it or paging can't advance.
   * @param {number} [opts.chunkSize=50] — ~5kB/row of payload on the raw
   *   ServiceTrade tables, so 50 rows ≈ 250kB per round trip. 100 was tried
   *   first and still timed out on a slow link (~500kB/chunk); the extra round
   *   trips cost ~250ms each, which is far cheaper than a failed sync.
   * @param {string} [opts.extraWhere] — additional static SQL predicate ANDed
   *   onto the company/keyset conditions (e.g. "servicetrade_appointment_id IS
   *   NOT NULL"). Callers pass literals only; never interpolate user input.
   * @returns {Promise<Array<object>>}
   */
  async fetchAllByCompanyChunked(companyId, table, { columns = "*", chunkSize = 50, extraWhere = null, updatedSince = null } = {}) {
    const all = [];
    let lastId = 0;
    let queryCount = 0;
    const start = Date.now();
    while (true) {
      // updatedSince is a bound parameter rather than folded into extraWhere:
      // callers pass a timestamp read out of the database, and interpolating
      // it into the SQL string would make this an injection surface for no
      // benefit.
      const params = [companyId, lastId];
      let sinceClause = "";
      if (updatedSince) {
        params.push(updatedSince);
        sinceClause = ` AND updated_at > $${params.length}`;
      }
      const { rows } = await this.query(
        `SELECT ${columns} FROM ${table}
          WHERE company_id = $1 AND id > $2${sinceClause}${extraWhere ? ` AND ${extraWhere}` : ""}
          ORDER BY id
          LIMIT ${chunkSize}`,
        params
      );
      queryCount++;
      all.push(...rows);
      if (rows.length < chunkSize) break;
      const next = rows[rows.length - 1].id;
      // Guard against a caller that projected `id` away — without it the
      // same page would be re-fetched forever.
      if (next == null) {
        throw new Error(`fetchAllByCompanyChunked(${table}): 'id' must be included in columns to paginate`);
      }
      lastId = next;
    }
    logger.info("fetchAllByCompanyChunked: table fetched", {
      table, companyId, rows: all.length, chunkSize, queries: queryCount,
      durationMs: Date.now() - start, ...(updatedSince ? { updatedSince } : {}),
    });
    return all;
  }

  /**
   * Fetch a company's full (external_ref -> id) map for a platform table in
   * ONE query, for resolving many FKs in memory instead of one SELECT per row.
   */
  async fetchExternalRefMap(companyId, table) {
    const { rows } = await this.query(
      `SELECT external_ref, id FROM ${table} WHERE company_id = $1 AND source = 'servicetrade' AND external_ref IS NOT NULL`,
      [companyId]
    );
    const map = new Map();
    for (const r of rows) map.set(r.external_ref, r.id);
    logger.info("fetchExternalRefMap: table fetched", { table, companyId, rows: map.size, queries: 1 });
    return map;
  }

  async transaction(callback) {
    const client = await this.getClient();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }

  async checkConnection() {
    try {
      await this.pool.query("SELECT 1");
      return true;
    } catch (error) {
      logger.error("Database health check failed", {
        error: error.message,
        code: error.code,
      });
      return false;
    }
  }
}

module.exports = new Database();
