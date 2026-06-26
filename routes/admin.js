const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');

router.get('/', (req, res) => {
  res.send(`
    <h1>Shurget Admin</h1>
    <p><a href="/admin/drivers">Drivers</a> | <a href="/admin/bookings">Bookings</a> | <a href="/admin/dispatch">Dispatch</a></p>
  `);
});

router.get('/drivers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM driver_applications ORDER BY created_at DESC');
    res.send(`<h1>Drivers (${result.rows.length})</h1><pre>${JSON.stringify(result.rows, null, 2)}</pre>`);
  } catch (e) {
    res.send('Error loading drivers');
  }
});

router.get('/bookings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.send(`<h1>Bookings (${result.rows.length})</h1><pre>${JSON.stringify(result.rows, null, 2)}</pre>`);
  } catch (e) {
    res.send('Error loading bookings');
  }
});

router.get('/dispatch', (req, res) => {
  res.send('<h1>Dispatch Board</h1><p>Coming soon - driver matching.</p>');
});

module.exports = router;
