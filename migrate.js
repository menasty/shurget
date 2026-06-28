const { pool } = require('./db/index');

async function migrate() {
  console.log('🚀 Running database migrations...');
  
  try {
    // Add stripe_session_id column if missing
    await pool.query(`
      ALTER TABLE orders 
      ADD COLUMN IF NOT EXISTS stripe_session_id TEXT;
    `);

    console.log('✅ Orders table updated with stripe_session_id');

    // Add driver onboarding columns if missing (safe to run repeatedly)
    await pool.query(`
      ALTER TABLE driver_applications
      ADD COLUMN IF NOT EXISTS vehicle_insurance_doc TEXT,
      ADD COLUMN IF NOT EXISTS driver_license_doc TEXT,
      ADD COLUMN IF NOT EXISTS vehicle_registration_doc TEXT,
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS background_check_consent BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS background_check_status TEXT DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS background_check_id TEXT,
      ADD COLUMN IF NOT EXISTS stripe_account_id TEXT,
      ADD COLUMN IF NOT EXISTS referral_code TEXT,
      ADD COLUMN IF NOT EXISTS referred_by_driver_id INTEGER,
      ADD COLUMN IF NOT EXISTS referred_by_driver_name TEXT,
      ADD COLUMN IF NOT EXISTS referral_bounty_paid_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS referral_bounty_transfer_id TEXT,
      ADD COLUMN IF NOT EXISTS utm_source TEXT,
      ADD COLUMN IF NOT EXISTS utm_medium TEXT,
      ADD COLUMN IF NOT EXISTS utm_campaign TEXT;
    `);

    console.log('✅ Driver applications table updated with onboarding columns');

    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE table_schema = 'public'
            AND table_name = 'driver_applications'
            AND constraint_name = 'driver_applications_referred_by_driver_id_fkey'
        ) THEN
          ALTER TABLE driver_applications
            ADD CONSTRAINT driver_applications_referred_by_driver_id_fkey
            FOREIGN KEY (referred_by_driver_id)
            REFERENCES driver_applications(id)
            ON DELETE SET NULL;
        END IF;
      END $$;
    `);

    console.log('✅ Driver applications self-referral FK verified');
  } catch (err) {
    // Never fail the deploy on a migration error — log and continue so the
    // server can still start. Each step above is individually idempotent.
    console.error('Migration error:', err);
  }
}

// IMPORTANT: the pg Pool keeps the event loop alive, so we must explicitly
// close it. Without this, `node migrate.js` never exits and the chained
// `npm run migrate && npm start` in render.yaml hangs forever — the server
// never boots and Render's health check fails.
migrate()
  .catch((err) => {
    console.error('Migration runner error:', err);
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (_) {
      // ignore pool teardown errors
    }
    process.exit(0);
  });
