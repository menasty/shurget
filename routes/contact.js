// routes/contact.js — Contact page + quote request API
// Owns: /contact GET, /api/contact POST
// Does NOT own: static contact info (lives in views/contact.ejs)

const express = require('express');
const router = express.Router();
const { createQuoteRequest } = require('../db/quote_requests');
const { sendQuoteRequestEmail } = require('../services/email');

/** GET /contact — render contact page */
router.get('/', (_req, res) => {
  res.render('contact');
});

/** POST /api/contact — submit quote request */
router.post('/', async (req, res) => {
  const { name, email, phone, item_description, pickup_address, dropoff_address } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  if (!/^[^\n@\\s]+@[^\n@\\s]+\\.[^\n@\\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  try {
    const request = await createQuoteRequest({
      name,
      email,
      phone,
      itemDescription: item_description,
      pickupAddress: pickup_address,
      dropoffAddress: dropoff_address,
    });

    // Send internal notification email
    sendQuoteRequestEmail(request).catch(err => {
      console.error('[contact] Failed to send notification email:', err.message);
    });

    return res.status(201).json({
      success: true,
      message: 'Quote request received! We will be in touch within 1 business day.',
      id: request.id,
    });
  } catch (err) {
    console.error('[contact] Error saving quote request:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;