/**
 * Database Migration Runner
 *
 * Runs on every deploy via `npm run build`.
 *
 * How it works:
 * 1. Creates core tables (users, _migrations) - always runs, idempotent
 * 2. Reads migrations from migrations/ folder
 * 3. Runs new migrations in order (tracked in _migrations table)
 *
 * To create a new migration:
 *   Create a file in migrations/ with format: {timestamp}_{name}.js
 *   Example: migrations/1704067200000_add_products_table.js
 *
 * Migration file format:
 *   module.exports = {
 *     name: 'add_products_table',
 *     up: async (client) => {
 *       await client.query(`CREATE TABLE products (...)`);
 *     }
 *   };
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function migrate() {
  console.log('Running migrations...');

  const client = await pool.connect();
  try {
    // 1. Create migration tracking table (always first)
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 2. Core tables (idempotent - safe to run every time)
    await runCoreMigrations(client);

    // 3. Run migrations from migrations/ folder
    await runFolderMigrations(client);

    console.log('Migrations complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

/**
 * Core tables that every app needs.
 * These use CREATE IF NOT EXISTS so they're safe to run repeatedly.
 */
async function runCoreMigrations(client) {
  // Users table with subscription support
  // Used by Polsia for syncing end-user subscription status
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      password_hash VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      -- Subscription fields (synced by Polsia when customer subscribes)
      stripe_subscription_id VARCHAR(255),
      subscription_status VARCHAR(50),
      subscription_plan VARCHAR(255),
      subscription_expires_at TIMESTAMPTZ,
      subscription_updated_at TIMESTAMPTZ
    )
  `);

  // Unique constraint on email (required for UPSERT)
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx ON users (LOWER(email))
  `);

  // Index for subscription lookups
  await client.query(`
    CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx ON users (stripe_subscription_id)
  `);
}

/**
 * Run migrations from migrations/ folder.
 * Each migration runs once and is tracked in _migrations table.
 */
async function runFolderMigrations(client) {
  const migrationsDir = path.join(__dirname, 'migrations');

  // Skip if no migrations folder
  if (!fs.existsSync(migrationsDir)) {
    return;
  }

  // Get all migration files (.js and .sql), sorted by name (timestamp prefix ensures order)
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.js') || f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    return;
  }

  // Get already-applied migrations
  const applied = await client.query('SELECT name FROM _migrations');
  const appliedNames = new Set(applied.rows.map(r => r.name));

  // Build a map: migrationKey (no extension) → list of files with that key
  // "1748842568_create_driver_applications.js" → "1748842568_create_driver_applications"
  const byKey = {};
  for (const f of files) {
    const strippedExt = f.split('/').pop().replace(/\/migrations\//, '').replace(/\/migrations\//, '').replace(/\/migrations\//, '');
    const ext = strippedExt.endsWith('.sql') ? '.sql' : strippedExt.endsWith('.js') ? '.js' : '';
    const key = strippedExt.slice(0, -ext.length).replace(/\/(index|up)?\/?$/, '').replace(/\/(index|up)?\/?$/, '');
    (byKey[key] = byKey[key] || []).push(f);
  }

  // Run pending migrations
  for (const file of files) {
    const strippedExt = file.split('/').pop().replace(/\/migrations\//, '').replace(/\/migrations\//, '').replace(/\/migrations\//, '');
    const ext = strippedExt.endsWith('.sql') ? '.sql' : strippedExt.endsWith('.js') ? '.js' : '';
    const migrationKey = strippedExt.slice(0, -ext.length).replace(/\/(index|up)?\/?$/, '').replace(/\/(index|up)?\/?$/, '');

    if (appliedNames.has(migrationKey)) {
      continue; // Already applied
    }

    // If a JS migration has a SQL sibling, skip the JS — SQL version is idempotent
    if (file.endsWith('.js')) {
      const siblings = byKey[migrationKey] || [];
      if (siblings.some(s => s.endsWith('.sql'))) {
        console.log(`Skipping (SQL version handles): ${migrationKey}`);
        continue;
      }
    }

    console.log(`Running migration: ${migrationKey}`);

    try {
      await client.query('BEGIN');

      if (file.endsWith('.sql')) {
        // SQL migration: read file and execute as-is
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await client.query(sql);
      } else {
        // JS migration: require and run the up() function
        const migration = require(path.join(migrationsDir, file));
        await migration.up(client);
      }

      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [migrationKey]);
      await client.query('COMMIT');
      console.log(`Migration complete: ${migrationKey}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      // AggregateError (Node.js multi-error) has empty .message — extract from first error
      const actualMsg = err.message || (err.errors?.[0]?.message) || String(err);
      console.error(`Migration error — name="${migrationKey}" msg="${actualMsg}"`);
      throw new Error(`Migration failed (${migrationKey}): ${actualMsg}`);
    }
  }
}

migrate().catch(err => {
  const actualMsg = err.message || (err.errors?.[0]?.message) || String(err);
  console.error('Migration failed:', actualMsg);
  process.exit(1);
});
