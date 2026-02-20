/**
 * Migration Runner
 * Executes SQL migration files in order.
 * Note: Does not track applied migrations - manage manually via Supabase dashboard.
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const config = require("../src/config");
const logger = require("../src/utils/logger");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

async function run() {
  // Check for specific file argument
  const specificFile = process.argv[2];

  const pool = new Pool({
    connectionString: config.database.url,
    ssl: config.database.url?.includes("supabase")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  const client = await pool.connect();

  try {
    // Get list of migration files
    let files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      logger.info("No migration files found in", MIGRATIONS_DIR);
      return;
    }

    // If specific file provided, only run that one
    if (specificFile) {
      if (!files.includes(specificFile)) {
        logger.error("Migration file not found:", specificFile);
        process.exit(1);
      }
      files = [specificFile];
    }

    for (const file of files) {
      const filePath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(filePath, "utf8");

      logger.info("Applying migration:", file);

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query("COMMIT");
        logger.info("Applied migration:", file);
      } catch (err) {
        await client.query("ROLLBACK");
        logger.error("Failed to apply migration:", file, err.message);
        throw err;
      }
    }

    logger.info(`Applied ${files.length} migration(s).`);
  } finally {
    client.release();
    await pool.end();
  }
}

run()
  .then(() => {
    logger.info("Migration runner finished.");
    process.exit(0);
  })
  .catch((err) => {
    logger.error("Migration runner failed:", err.message);
    process.exit(1);
  });
