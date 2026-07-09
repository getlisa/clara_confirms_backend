/**
 * Migration Runner
 *
 * Executes SQL migration files in order, tracking applied migrations in a
 * `schema_migrations` ledger so each file runs exactly once. Re-running is safe:
 * already-applied files are skipped.
 *
 * Bootstrapping an existing (already-migrated) database: a migration whose
 * objects already exist (duplicate table/column/constraint/etc.) is treated as
 * already applied — it is recorded in the ledger and skipped, rather than
 * aborting the run. Any OTHER error still aborts. This lets the ledger adopt a
 * database that was migrated before the ledger existed.
 *
 * Usage:
 *   node scripts/run-migrations.js                 — apply all pending migrations
 *   node scripts/run-migrations.js 056_foo.sql     — (re-)apply one file
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const config = require("../src/config");
const logger = require("../src/utils/logger");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Postgres error codes that mean "this object already exists" — i.e. the
// migration was already applied out-of-band. Safe to treat as applied.
const ALREADY_APPLIED_CODES = new Set([
  "42P07", // duplicate_table
  "42P06", // duplicate_schema
  "42701", // duplicate_column
  "42710", // duplicate_object (constraint, index, etc.)
  "42723", // duplicate_function
  "42711", // duplicate_object (index name)
  "42P16", // invalid_table_definition (re-adding an existing constraint variant)
]);

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function getApplied(client) {
  const { rows } = await client.query("SELECT filename FROM schema_migrations");
  return new Set(rows.map((r) => r.filename));
}

async function record(client, file) {
  await client.query(
    "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
    [file]
  );
}

async function run() {
  const specificFile = process.argv[2];

  const pool = new Pool({
    connectionString: config.database.url,
    ssl: config.database.url?.includes("supabase")
      ? { rejectUnauthorized: false }
      : undefined,
  });

  const client = await pool.connect();

  try {
    await ensureLedger(client);
    const applied = await getApplied(client);

    let files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      logger.info("No migration files found in", MIGRATIONS_DIR);
      return;
    }

    if (specificFile) {
      if (!files.includes(specificFile)) {
        logger.error("Migration file not found:", specificFile);
        process.exit(1);
      }
      files = [specificFile]; // explicit file: run even if already recorded
    }

    let ran = 0, adopted = 0, skipped = 0;

    for (const file of files) {
      if (!specificFile && applied.has(file)) {
        skipped++;
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      logger.info("Applying migration:", file);

      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING",
          [file]
        );
        await client.query("COMMIT");
        logger.info("Applied migration:", file);
        ran++;
      } catch (err) {
        await client.query("ROLLBACK");
        if (ALREADY_APPLIED_CODES.has(err.code)) {
          // Objects already exist — adopt this migration into the ledger.
          await record(client, file);
          logger.warn("Migration objects already exist — marking as applied:", file, `(${err.code})`);
          adopted++;
          continue;
        }
        logger.error("Failed to apply migration:", file, err.message);
        throw err;
      }
    }

    logger.info(`Migrations complete. applied=${ran} adopted=${adopted} skipped=${skipped}`);
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
