const { Pool } = require("pg");
const config = require("../config");
const logger = require("../utils/logger");

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
      statement_timeout: 30000,
      query_timeout: 35000,
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
      client.query("SET timezone = 'UTC'").catch((err) => {
        logger.warn("Failed to set timezone on connection", {
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
