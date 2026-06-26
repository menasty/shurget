const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');
const Stripe = require('stripe');

function getStripeClient() {
  const rawKey = process.env.STRIPE_SECRET_KEY;
  const stripeKey = typeof rawKey === 'string' ? rawKey.trim().replace(/^['\"]|['\"]$/g, '') : '';

  if (!stripeKey || (!stripeKey.startsWith('sk_test_') && !stripeKey.startsWith('sk_live_'))) {
    throw new Error('Invalid STRIPE_SECRET_KEY configuration');
  }

  return new Stripe(stripeKey);
}

router.get('/', (req, res) => {
  res.render('booking');
});

router.post('/', async (req, res) => {
  try {
    const { itemType, pickupAddress, dropoffAddress, helpers = '0' } = req.body;
    
    const helperCount = parseInt(helpers) || 0;
    const basePrice = 89;
    const helperPrice = helperCount * 25;
    const totalAmount = basePrice + helperPrice;

    const stripeClient = getStripeClient();

    const session = await stripeClient.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `${itemType} Delivery`,
            description: `${pickupAddress} → ${dropoffAddress}`,
          },
          unit_amount: totalAmount * 100,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `https://shurgetapp.com/confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://shurgetapp.com/book`,
      metadata: {
        itemType,
        pickupAddress,
        dropoffAddress,
        helpers: helperCount.toString()
      }
    });

    res.redirect(session.url);
  } catch (err) {
    if (err && err.message === 'Invalid STRIPE_SECRET_KEY configuration') {
      console.error('Stripe configuration error: STRIPE_SECRET_KEY is missing or malformed');
      return res.status(503).send('Payments are temporarily unavailable. Please try again later.');
    }

    console.error('Stripe error:', err);
    res.status(500).send('Payment session failed. Please try again.');
  }
});

module.exports = router;
