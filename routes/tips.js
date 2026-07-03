// routes/tips.js — Post-delivery optional tip flow
// POST /tip/:orderId  — customer submits tip amount
// Charges via Stripe PaymentIntent (separate from original booking charge)
// Transfers tip to driver via Stripe Connect after capture

const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db/index');
const { addTipToOrder, getOrderById } = require('../db/orders');

const MIN_TIP_CENTS = 100;   // $1.00 minimum
const MAX_TIP_CENTS = 10000; // $100.00 maximum

/**
 * POST /tip/:orderId
 * Body: { tipAmountCents: 500, paymentMethodId: 'pm_xxx' }
 * — or —
 * Body: { tipAmountCents: 500, returnUrl: 'https://...' }  (redirect flow)
 *
 * Returns JSON: { success, clientSecret?, message }
 */
router.post('/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (!orderId) return res.status(400).json({ error: 'Invalid order id' });

  const tipCents = parseInt(req.body.tipAmountCents, 10);
  if (!tipCents || tipCents < MIN_TIP_CENTS || tipCents > MAX_TIP_CENTS) {
    return res.status(400).json({ error: `Tip must be between $${MIN_TIP_CENTS / 100} and $${MAX_TIP_CENTS / 100}` });
  }

  // Fetch order — must be delivered before tip is allowed
  let order;
  try {
    order = await getOrderById(orderId);
  } catch (e) {
    return res.status(404).json({ error: 'Order not found' });
  }
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'delivered') {
    return res.status(409).json({ error: 'Tip can only be added after delivery is complete' });
  }
  if (order.tip_amount_cents > 0) {
    return res.status(409).json({ error: 'Tip already applied to this order' });
  }

  // Look up driver's Stripe Connect account
  let driverConnectId = null;
  try {
    const { rows } = await pool.query(
      'SELECT stripe_account_id FROM driver_applications WHERE id = $1',
      [order.driver_id]
    );
    driverConnectId = rows[0]?.stripe_account_id || null;
  } catch (e) {
    console.error('[tip] driver connect lookup failed:', e.message);
  }

  try {
    // Create a PaymentIntent for the tip
    const intentParams = {
      amount: tipCents,
      currency: 'usd',
      description: `Tip for Shurget order #${orderId}`,
      metadata: {
        order_id: String(orderId),
        tip: 'true',
        driver_id: String(order.driver_id || ''),
      },
    };

    // If driver has Connect account, transfer tip directly to them
    if (driverConnectId) {
      intentParams.transfer_data = { destination: driverConnectId };
      intentParams.on_behalf_of = driverConnectId;
    }

    const paymentMethodId = req.body.paymentMethodId;
    if (paymentMethodId) {
      intentParams.payment_method = paymentMethodId;
      intentParams.confirm = true;
      intentParams.return_url = req.body.returnUrl || `${req.protocol}://${req.get('host')}/confirmation/${orderId}?tipped=1`;
    }

    const intent = await stripe.paymentIntents.create(intentParams);

    // Record the tip in DB
    await addTipToOrder(orderId, tipCents);

    return res.json({
      success: true,
      clientSecret: intent.client_secret,
      intentId: intent.id,
      status: intent.status,
      message: `Thank you! Your $${(tipCents / 100).toFixed(2)} tip has been sent to your driver.`,
    });
  } catch (e) {
    console.error('[tip] Stripe error:', e.message);
    return res.status(500).json({ error: 'Payment failed. Please try again.' });
  }
});

/**
 * GET /tip/:orderId/status
 * Returns whether order is tippable and current tip state.
 */
router.get('/:orderId/status', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  if (!orderId) return res.status(400).json({ error: 'Invalid order id' });
  try {
    const order = await getOrderById(orderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    return res.json({
      orderId,
      status: order.status,
      tippable: order.status === 'delivered' && !order.tip_amount_cents,
      tipAmountCents: order.tip_amount_cents || 0,
      tipDollars: ((order.tip_amount_cents || 0) / 100).toFixed(2),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Could not fetch order' });
  }
});

module.exports = router;
