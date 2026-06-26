const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');

router.get('/', async (req, res) => {
  const sessionId = req.query.session_id;
  
  try {
    // Save the order as paid
    if (sessionId) {
      await pool.query(`
        INSERT INTO orders (item_type, pickup_address, dropoff_address, helpers, status, stripe_session_id, created_at)
        VALUES ($1, $2, $3, $4, 'paid', $5, NOW())
      `, ['Unknown', 'Unknown', 'Unknown', 0, sessionId]); // We'll improve metadata later
    }
  } catch (e) {
    console.error('Failed to save order:', e);
  }

  res.render('confirmation', { 
    sessionId: sessionId || 'N/A',
    title: 'Payment Successful - Shurget'
  });
});

module.exports = router;
