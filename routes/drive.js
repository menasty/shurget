const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');

router.get('/', (req, res) => {
  res.render('drive', { 
    application: null,
    ga4Id: process.env.GA4_MEASUREMENT_ID || ''
  });
});

router.get('/earn', (req, res) => {
  res.render('drive-earn', { refCode: null, referrerName: null });
});

// Handle driver application submission
router.post('/', async (req, res) => {
  try {
    const { name, email, phone, vehicleType, city } = req.body;

    if (!name || !email || !phone || !vehicleType || !city) {
      return res.status(400).send('Missing required fields');
    }

    const result = await pool.query(`
      INSERT INTO driver_applications (name, email, phone, vehicle_type, city, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      RETURNING id
    `, [name, email, phone, vehicleType, city]);

    res.send(`
      <h2 style="color:#ea580c">✅ Application Received!</h2>
      <p>Thank you, ${name}. Your application has been submitted.</p>
      <p>We'll review it and get back to you shortly.</p>
      <p><a href="/drive">Submit Another Application</a> | <a href="/">Back to Home</a></p>
    `);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error submitting application. Please try again.');
  }
});

module.exports = router;
