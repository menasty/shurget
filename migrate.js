const { pool } = require('./db/index');

async function migrate() {
  console.log('🚀 Running database migrations...');
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_applications (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        vehicle_type TEXT,
        city TEXT,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ Core tables created successfully');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    client.release();
  }
}

migrate().catch(console.error);
