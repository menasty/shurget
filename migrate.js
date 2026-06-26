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
  } catch (err) {
    console.error('Migration error:', err);
  }
}

migrate().catch(console.error);
