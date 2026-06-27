const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');

router.get('/', (req, res) => {
  res.render('drive', { application: null });
});

router.post('/', async (req, res) => {
  try {
    const wantsJson = req.is('application/json');
    const { name, email, phone, vehicleType, city } = req.body;

    if (!name || !email || !phone || !vehicleType || !city) {
      if (wantsJson) {
        return res.status(400).json({ error: 'All fields are required.' });
      }
      return res.status(400).send('All fields are required.');
    }

    const result = await pool.query(`
      INSERT INTO driver_applications (name, email, phone, vehicle_type, city, status, created_at)
      VALUES ($1, $2, $3, $4, $5, 'pending', NOW())
      RETURNING id
    `, [name, email, phone, vehicleType, city]);

    if (wantsJson) {
      return res.json({
        ok: true,
        application: {
          id: result.rows[0].id,
          email,
        },
      });
    }

    res.send(`
      <div style="max-width: 600px; margin: 80px auto; padding: 40px; text-align: center; font-family: system-ui;">
        <h1 style="color: #ea580c;">✅ Application Submitted!</h1>
        <p>Thank you, ${name}.</p>
        <p>Your driver application has been received and is under review.</p>
        <p>We will contact you shortly.</p>
        <p><a href="/drive">Submit Another Application</a> | <a href="/">← Back to Home</a></p>
      </div>
    `);
  } catch (err) {
    console.error(err);
    if (req.is('application/json')) {
      return res.status(500).json({ error: 'Error submitting application. Please try again.' });
    }
    res.status(500).send('Error submitting application. Please try again.');
  }
});

module.exports = router;
