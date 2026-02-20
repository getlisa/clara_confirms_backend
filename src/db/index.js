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
      connectionTimeoutMillis: isServerless ? 30000 : 10000,
      statement_timeout: isServerless ? 30000 : undefined,
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
        /connection terminated|ECONNRESET|ECONNREFUSED|connect ENOENT|Connection lost/i.test(
          error.message
        ) || error.code === "57P01";
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
