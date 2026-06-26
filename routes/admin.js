const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');

router.get('/', (req, res) => {
  res.render('admin-index');
});

router.get('/drivers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM driver_applications ORDER BY created_at DESC');
    res.render('admin-drivers', { drivers: result.rows });
  } catch (e) {
    res.send('Error loading drivers');
  }
});

router.get('/bookings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.render('admin-bookings', { orders: result.rows });
  } catch (e) {
    res.send('Error loading bookings');
  }
});

router.get('/dispatch', (req, res) => {
  res.render('admin-dispatch');
});

module.exports = router;
