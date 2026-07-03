// routes/booking.js — Customer booking page + checkout session creation
// Owns: /book GET (form), /book POST (create order + Stripe Checkout)
// Does NOT own: webhook payment confirmation (routes/webhooks.js)

const express = require('express');
const router = express.Router();
const { createOrder, setStripeSession } = require('../db/orders');
const { createCheckoutSession } = require('../services/stripe');

/** GET /book — render the booking form */
router.get('/', (_req, res) => {
  res.render('booking');
});

/** POST /book — create a pending order and redirect to Stripe Checkout */
router.post('/', async (req, res) => {
  try {
    const {
      itemType,
      pickupAddress,
      dropoffAddress,
      helpers = '0',
      applianceAddon = 'none',
      customerName,
      customerEmail,
      customerPhone,
    } = req.body;

    if (!itemType || !pickupAddress || !dropoffAddress) {
      return res.status(400).send('Please fill in the item type and both addresses.');
    }

    const helperCount = parseInt(helpers, 10) || 0;

    // Validate and normalize appliance add-on
    const addonValue = (itemType === 'appliance' && applianceAddon === 'second_appliance')
      ? 'second_appliance'
      : 'none';

    // Create the order in pending_payment so the Stripe webhook can flip it to paid.
    const order = await createOrder({
      itemType,
      pickupAddress,
      dropoffAddress,
      helpers: helperCount,
      applianceAddon: addonValue,
      customerName: customerName || null,
      customerEmail: customerEmail || null,
      customerPhone: customerPhone || null,
      status: 'pending_payment',
    });

    const session = await createCheckoutSession({
      orderId: order.id,
      amount: order.price_total,
      itemType: order.item_type,
      customerEmail: order.customer_email,
    });

    await setStripeSession(order.id, session.id);

    return res.redirect(303, session.url);
  } catch (err) {
    if (err && /STRIPE_SECRET_KEY/.test(err.message || '')) {
      console.error('[booking] Stripe not configured:', err.message);
      return res.status(503).send('Payments are temporarily unavailable. Please try again later.');
    }
    console.error('[booking] Failed to create checkout session:', err);
    return res.status(500).send('Something went wrong creating your booking. Please try again.');
  }
});

module.exports = router;
