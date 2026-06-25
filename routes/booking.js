const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');

router.get('/', (req, res) => {
  res.render('booking');
});

router.post('/', async (req, res) => {
  try {
    const { itemType, pickupAddress, dropoffAddress, helpers = '0' } = req.body;
    
    const result = await pool.query(`
      INSERT INTO orders (item_type, pickup_address, dropoff_address, helpers, status, created_at)
      VALUES ($1, $2, $3, $4, 'pending', NOW())
      RETURNING id
    `, [itemType, pickupAddress, dropoffAddress, parseInt(helpers)]);

    const orderId = result.rows[0].id;

    res.send(`
      <div style="max-width: 600px; margin: 40px auto; padding: 40px; text-align: center; font-family: system-ui;">
        <h1 style="color: #ea580c;">✅ Order #${orderId} Received!</h1>
        <p>Thank you. Your booking has been created and is pending driver assignment.</p>
        <p><a href="/book">Book Another Haul</a> | <a href="/">← Back to Home</a></p>
      </div>
    `);
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).send('Error creating order. Please try again.');
  }
});

module.exports = router;
