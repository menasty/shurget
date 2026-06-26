const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');

router.get('/', (req, res) => {
  res.send(`
    <h1 style="text-align:center; color:#ea580c;">Shurget Admin Panel</h1>
    <p style="text-align:center;">
      <a href="/admin/drivers">Drivers</a> | 
      <a href="/admin/bookings">Bookings</a> | 
      <a href="/admin/dispatch">Dispatch</a>
    </p>
  `);
});

router.get('/drivers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM driver_applications ORDER BY created_at DESC');
    res.send(`<h2>Drivers (${result.rows.length})</h2><pre>${JSON.stringify(result.rows, null, 2)}</pre>`);
  } catch (e) {
    res.send('Error loading drivers');
  }
});

router.get('/bookings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    let html = `<h2>Recent Bookings (${result.rows.length})</h2>`;
    html += '<table border="1" cellpadding="8" style="width:100%; border-collapse:collapse;">';
    html += '<tr><th>ID</th><th>Item</th><th>Pickup</th><th>Dropoff</th><th>Status</th><th>Date</th></tr>';
    result.rows.forEach(row => {
      html += `<tr>
        <td>${row.id}</td>
        <td>${row.item_type}</td>
        <td>${row.pickup_address}</td>
        <td>${row.dropoff_address}</td>
        <td>${row.status}</td>
        <td>${row.created_at}</td>
      </tr>`;
    });
    html += '</table>';
    res.send(html);
  } catch (e) {
    res.send('Error loading bookings');
  }
});

router.get('/dispatch', (req, res) => {
  res.send('<h2>Dispatch Board</h2><p>Driver matching coming soon.</p>');
});

module.exports = router;
