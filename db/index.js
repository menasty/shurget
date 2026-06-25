const { Pool } = require('pg');

const INVALID_DB_HOSTS = new Set(['', 'base', 'localhost', '127.0.0.1', '::1']);

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isInvalidHost(hostname) {
  return INVALID_DB_HOSTS.has(normalize(hostname).toLowerCase());
}

function hasCompletePgConfig(pgHost, pgUser, pgDatabase) {
  return Boolean(pgHost && pgUser && pgDatabase && !isInvalidHost(pgHost));
}

function buildPoolConfig() {
  const rawDatabaseUrl = normalize(process.env.DATABASE_URL);
  const pgHost = normalize(process.env.PGHOST);
  const pgUser = normalize(process.env.PGUSER);
  const pgPassword = normalize(process.env.PGPASSWORD);
  const pgDatabase = normalize(process.env.PGDATABASE);
  const pgPort = Number.parseInt(normalize(process.env.PGPORT) || '5432', 10);

  // Prefer DATABASE_URL but repair common placeholder host mistakes.
  if (rawDatabaseUrl) {
    try {
      const parsed = new URL(rawDatabaseUrl);
      if (isInvalidHost(parsed.hostname) && pgHost && !isInvalidHost(pgHost)) {
        parsed.hostname = pgHost;
        if (Number.isFinite(pgPort)) {
          parsed.port = String(pgPort);
        }
        return { connectionString: parsed.toString() };
      }

      if (!isInvalidHost(parsed.hostname)) {
        return { connectionString: rawDatabaseUrl };
      }

      console.warn(`[db] Ignoring DATABASE_URL with invalid hostname: ${parsed.hostname}`);
    } catch (error) {
      console.warn('[db] Ignoring invalid DATABASE_URL format and trying PG* env vars');
    }
  }

  // Fallback to discrete PG* vars when DATABASE_URL is missing or invalid.
  if (hasCompletePgConfig(pgHost, pgUser, pgDatabase)) {
    return {
      host: pgHost,
      port: Number.isFinite(pgPort) ? pgPort : 5432,
      user: pgUser,
      password: pgPassword,
      database: pgDatabase
    };
  }

  throw new Error(
    '[db] Missing valid PostgreSQL configuration. Set DATABASE_URL to a real remote host or set PGHOST/PGUSER/PGPASSWORD/PGDATABASE (PGHOST cannot be localhost/base in production).'
  );
}

const pool = new Pool({
  ...buildPoolConfig(),
  ssl: {
    rejectUnauthorized: false
  }
});

module.exports = { pool };
