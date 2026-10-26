const { pool } = require('./db/index');

// NOTE: this file must only ever contain FICTIONAL test drivers. Never put a
// real name, email, or phone number here — driver login is email + last 4 of
// phone, so a real entry in this file is effectively working credentials.
async function seedTestDrivers() {
  try {
    await pool.query(`
      INSERT INTO driver_applications (name, email, phone, vehicle_type, city, status)
      VALUES 
        ('Jordan Meyer', 'jordan.meyer@example.com', '555-010-1001', 'Toyota Tundra', 'Castle Rock', 'active'),
        ('Test Driver One', 'test1@example.com', '555-111-2222', 'Ford F-150', 'Denver', 'active'),
        ('Test Driver Two', 'test2@example.com', '555-333-4444', 'Chevy Silverado', 'Aurora', 'pending')
      ON CONFLICT (email) DO NOTHING;
    `);
    console.log('✅ Test drivers seeded successfully!');
  } catch (err) {
    console.error('Seed error:', err.message);
  }
}

seedTestDrivers().then(() => process.exit(0));
