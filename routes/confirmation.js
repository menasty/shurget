// routes/confirmation.js — Post-checkout confirmation page
// Owns: /confirmation and /confirmation/:orderId GET
// Payment state is owned by routes/webhooks.js — this page only displays.

const express = require('express');
const router = express.Router();
const { getOrderById } = require('../db/orders');
const { requireTrackToken } = require('../middleware/track-token');

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
    // Passed through so the "Track Your Delivery" link carries the same
    // token (empty for admin sessions, which bypass the token gate anyway).
    trackToken: req.trackToken || req.query.token || '',
  });
}

router.get('/', renderConfirmation);
// :orderId is gated like /track/:id: a bare sequential id no longer opens
// someone else's confirmation. The post-checkout landing still works because
// Stripe success/cancel URLs now carry a token (services/stripe.js), and the
// emailed confirmation link is tokenized too (services/email.js).
router.get('/:orderId', requireTrackToken, renderConfirmation);

module.exports = router;
