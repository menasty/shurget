// routes/confirmation.js — Post-checkout confirmation page
// Owns: /confirmation and /confirmation/:orderId GET
// Payment state is owned by routes/webhooks.js — this page only displays.

const express = require('express');
const router = express.Router();
const { getOrderById } = require('../db/orders');

async function renderConfirmation(req, res) {
  const orderId = req.params.orderId;
  let order = null;
  if (orderId) {
    try {
      order = await getOrderById(orderId);
    } catch (err) {
      console.error('[confirmation] failed to load order:', err.message);
    }
  }
  res.render('confirmation', {
    order,
    title: 'Booking Confirmed - Shurget',
    stripePublishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
  });
}

router.get('/', renderConfirmation);
router.get('/:orderId', renderConfirmation);

module.exports = router;
