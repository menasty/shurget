const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');

router.get('/', (req, res) => {
  res.render('admin-index', { adminEmail: 'admin@shurget.com' });
});

// Drivers
router.get('/drivers', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM driver_applications ORDER BY created_at DESC');
    res.render('admin-drivers', { 
      drivers: result.rows || [],
      adminEmail: 'admin@shurget.com'
    });
  } catch (e) {
    res.render('admin-drivers', { drivers: [], adminEmail: 'admin@shurget.com' });
  }
});

// Bookings
router.get('/bookings', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM orders ORDER BY created_at DESC');
    res.render('admin-bookings', { 
      orders: result.rows || [],
      flash: null,
      adminEmail: 'admin@shurget.com'
    });
  } catch (e) {
    res.render('admin-bookings', { orders: [], flash: null, adminEmail: 'admin@shurget.com' });
  }
});

// Dispatch
router.get('/dispatch', async (req, res) => {
  try {
    const drivers = await pool.query('SELECT * FROM driver_applications WHERE status = $1', ['active']);
    res.render('admin-dispatch', { 
      drivers: drivers.rows || [],
      pending: [],
      active: [],
      adminEmail: 'admin@shurget.com'
    });
  } catch (e) {
    res.render('admin-dispatch', { drivers: [], pending: [], active: [], adminEmail: 'admin@shurget.com' });
  }
});

// Metrics
router.get('/metrics', (req, res) => {
  res.render('admin-metrics', { 
    metrics: { 
      totals: { total_orders: 0, completed: 0, cancelled: 0, avg_order_value: 0 },
      week: { cnt: 0, revenue: 0 },
      month: { cnt: 0, revenue: 0 }
    },
    byStatus: [],
    daily: [],
    adminEmail: 'admin@shurget.com'
  });
});

// Ratings
router.get('/ratings', (req, res) => {
  res.render('admin-ratings', { adminEmail: 'admin@shurget.com' });
});

module.exports = router;
