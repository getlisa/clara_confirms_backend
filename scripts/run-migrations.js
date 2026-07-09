/**
 * Migration Runner
 *
 * Executes SQL migration files in order, tracking applied migrations in a
 * `schema_migrations` ledger so each file runs exactly once. Re-running is safe:
 * already-applied files are skipped.
 *
 * Baseline adoption: this database was provisioned before the ledger existed
 * (migrations 001..052 were applied out-of-band / directly). On a database that
 * is already provisioned (the `companies` table exists), every migration at or
 * before BASELINE is recorded as applied WITHOUT executing it — re-running those
 * old files would fail (duplicate objects, already-renamed columns, etc.). Only
 * migrations after BASELINE actually run. On a fresh/unprovisioned database,
 * nothing is baselined and all migrations run normally.
 *
 * Usage:
 *   node scripts/run-migrations.js                 — apply all pending migrations
 *   node scripts/run-migrations.js 056_foo.sql     — (re-)apply one file (forced)
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const config = require("../src/config");
const logger = require("../src/utils/logger");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

// Last migration that existed before the ledger was introduced. Everything up to
// and including this is assumed already applied on a provisioned database.
const BASELINE = "052_copilot.sql";

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function isProvisioned(client) {
  const { rows } = await client.query("SELECT to_regclass('public.companies') AS t");
  return !!rows[0].t;
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

    let files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    if (files.length === 0) {
      logger.info("No migration files found in", MIGRATIONS_DIR);
      return;
    }

    // Baseline adoption (skip on an explicit single-file run).
    if (!specificFile && (await isProvisioned(client))) {
      const baseline = files.filter((f) => f <= BASELINE);
      for (const f of baseline) await record(client, f);
      if (baseline.length) {
        logger.info(`Baseline: adopted ${baseline.length} pre-ledger migration(s) as applied (<= ${BASELINE}).`);
      }
    }

    const { rows } = await client.query("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.filename));

    if (specificFile) {
      if (!files.includes(specificFile)) {
        logger.error("Migration file not found:", specificFile);
        process.exit(1);
      }
      files = [specificFile]; // explicit file: run even if already recorded
    }

    let ran = 0, skipped = 0;

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
        logger.error("Failed to apply migration:", file, err.message);
        throw err;
      }
    }

    logger.info(`Migrations complete. applied=${ran} skipped=${skipped}`);
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
