// routes/webhooks.js — Stripe webhook handler
// Owns: receiving and verifying Stripe webhook events
// Does NOT own: Checkout session creation, payment processing logic

const express = require('express');
const router = express.Router();
const { markOrderPaidFromWebhook, getOrderById } = require('../db/orders');
const { pool } = require('../db/index');
const { sendConfirmationEmail, sendReferralCodeEmail, sendReferrerCreditEmail, sendPaymentFailureEmail } = require('../services/email');
const { sendOrderConfirmedSms, sendAdminPaymentFailureSms } = require('../services/sms');
const { getOrCreateReferralCode, getReferralCodeByCode, recordRedemption, getRedemptionByOrderId, createSingleUseCreditCode } = require('../db/referrals');
const { notifyDriversOfNewJob } = require('../services/driver');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Lazily init to avoid crash when key is absent in dev
function getStripe() {
  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
  const Stripe = require('stripe');
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2025-04-30.basil' });
}

/**
 * POST /api/webhooks/stripe
 * Receives Stripe webhook events, verifies signature, and handles them.
 * Raw body must be preserved — this route is mounted with express.raw() body parser.
 */
router.post('/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      // Dev/staging without webhook secret — parse body directly
      event = JSON.parse(req.body.toString());
      console.warn('[webhooks] STRIPE_WEBHOOK_SECRET not set — skipping signature verification');
    }
  } catch (err) {
    console.error('[webhooks] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature error: ${err.message}` });
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;

      if (!orderId) {
        console.error('[webhooks] checkout.session.completed missing orderId in metadata');
        return res.status(400).json({ error: 'Missing orderId in metadata' });
      }

      const order = await markOrderPaidFromWebhook(orderId, new Date(event.created * 1000));
      if (!order) {
        console.error('[webhooks] Order not found:', orderId);
        return res.status(404).json({ error: 'Order not found' });
      }

      // Persist the payment_intent id so chargebacks (charge.dispute.created)
      // can be matched directly back to this order without re-querying Stripe.
      if (session.payment_intent) {
        pool.query('UPDATE orders SET stripe_payment_intent_id = $1 WHERE id = $2', [session.payment_intent, order.id])
          .catch(err => console.error('[webhooks] Failed to save payment_intent id:', err.message));
      }

      // Send confirmation email (fire-and-forget)
      if (order.customer_email) {
        sendConfirmationEmail(order).catch(err => {
          console.error('[webhooks] Failed to send confirmation email:', err.message);
        });
      }

      // Send order confirmed SMS (opt-in gated)
      sendOrderConfirmedSms(order).catch(err => {
        console.error('[webhooks] Failed to send order confirmed SMS:', err.message);
      });

      // Alert active drivers of the new available job (email with claim link)
      notifyDriversOfNewJob(order).catch(err => {
        console.error('[webhooks] Failed to notify drivers of new job:', err.message);
      });

      // Referral: generate code for referrer on first completed order,
      // and process any referral code that was used on this order.
      handleReferralOnPayment(order).catch(err => {
        console.error('[webhooks] Referral post-payment error:', err.message);
      });

      console.log(`[webhooks] Order ${orderId} marked paid via webhook`);
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;
      if (orderId) {
        // Alert admin
        sendAdminPaymentFailureSms(orderId).catch(err => {
          console.error('[webhooks] Failed to send admin payment failure SMS:', err.message);
        });
        // Send customer payment failure email
        getOrderById(orderId).then(order => {
          if (order && order.customer_email) {
            sendPaymentFailureEmail(order, 'Your checkout session expired before payment was completed. Please try again.').catch(err => {
              console.error('[webhooks] Payment failure email failed:', err.message);
            });
          }
        }).catch(err => {
          console.error('[webhooks] getOrderById failed for payment failure email:', err.message);
        });
        console.log(`[webhooks] Checkout session expired for order ${orderId}`);
      }
    }

    if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object;
      const orderId = session.metadata?.orderId;
      if (orderId) {
        const reason = session.last_payment_error?.message || 'Payment was declined by your bank.';
        sendAdminPaymentFailureSms(orderId).catch(err => {
          console.error('[webhooks] Failed to send admin payment failure SMS:', err.message);
        });
        getOrderById(orderId).then(order => {
          if (order && order.customer_email) {
            sendPaymentFailureEmail(order, reason).catch(err => {
              console.error('[webhooks] Payment failure email failed:', err.message);
            });
          }
        }).catch(err => {
          console.error('[webhooks] getOrderById failed for async payment failure:', err.message);
        });
        console.log(`[webhooks] Async payment failed for order ${orderId}: ${reason}`);
      }
    }

    // Handle chargeback: freeze payout, mark order disputed, alert admin.
    // Supports both snapshot (full object) and thin (id-only) payload styles.
    if (event.type === 'charge.dispute.created') {
      const stripe = getStripe();
      // Thin payload: event.data.object may only contain { id, object }
      // Re-fetch the full dispute from Stripe to guarantee all fields are present.
      const disputeId = event.data.object.id;
      let dispute;
      try {
        dispute = await stripe.disputes.retrieve(disputeId);
      } catch (fetchErr) {
        console.error(`[webhooks] Failed to retrieve dispute ${disputeId}:`, fetchErr.message);
        return res.status(200).json({ received: true }); // ack to Stripe, handle manually
      }
      const paymentIntentId = dispute.payment_intent;

      let orderRow = null;
      if (paymentIntentId) {
        const byIntent = await pool.query(
          'SELECT id, driver_id, price_total FROM orders WHERE stripe_payment_intent_id = $1 LIMIT 1',
          [paymentIntentId]
        );
        orderRow = byIntent.rows[0] || null;
      }

      if (!orderRow) {
        console.error(`[webhooks] charge.dispute.created: no order found for payment_intent ${paymentIntentId}. Dispute ${dispute.id} could not be matched — manual lookup required.`);
      } else {
        await pool.query('UPDATE orders SET status = $1 WHERE id = $2', ['disputed', orderRow.id]);

        if (orderRow.driver_id) {
          // $0 hold entry — freezes the driver's payout for this order pending resolution.
          // (driver_adjustments has no separate "held" flag, so a $0 line item with an
          // explanatory reason is used as the audit trail; admin resolves manually.)
          await pool.query(
            'INSERT INTO driver_adjustments (driver_id, order_id, amount_cents, reason) VALUES ($1,$2,0,$3)',
            [orderRow.driver_id, orderRow.id, `HOLD: chargeback dispute on order #${orderRow.id} — payout frozen pending resolution (dispute ${dispute.id})`]
          );
        }

        console.error(`[ADMIN ALERT] Chargeback filed on Order #${orderRow.id} — dispute ${dispute.id}, amount $${(dispute.amount / 100).toFixed(2)}. Payout frozen.`);
      }
    }

    // Handle a failed driver payout transfer — alert admin, queue for retry.
    // Supports both snapshot (full object) and thin (id-only) payload styles.
    if (event.type === 'transfer.failed') {
      const stripe = getStripe();
      // Thin payload: re-fetch the full transfer object from Stripe.
      const transferId = event.data.object.id;
      let transfer;
      try {
        transfer = await stripe.transfers.retrieve(transferId);
      } catch (fetchErr) {
        console.error(`[webhooks] Failed to retrieve transfer ${transferId}:`, fetchErr.message);
        return res.status(200).json({ received: true }); // ack to Stripe, handle manually
      }
      const stripeAccountId = transfer.destination;

      const driverRes = await pool.query(
        'SELECT id, name FROM driver_applications WHERE stripe_account_id = $1 LIMIT 1',
        [stripeAccountId]
      );

      if (driverRes.rows.length === 0) {
        console.error(`[webhooks] transfer.failed: no driver found for Stripe account ${stripeAccountId}. Transfer ${transfer.id} could not be matched.`);
      } else {
        const driver = driverRes.rows[0];
        await pool.query(
          'INSERT INTO driver_adjustments (driver_id, order_id, amount_cents, reason) VALUES ($1,NULL,$2,$3)',
          [driver.id, transfer.amount, `Failed transfer retry queued — transfer ${transfer.id}`]
        );
        console.error(`[ADMIN ALERT] Driver payout failed: ${driver.name} (driver #${driver.id}), $${(transfer.amount / 100).toFixed(2)}, transfer ${transfer.id}.`);
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('[webhooks] Error processing event:', err);
    return res.status(500).json({ error: 'Internal error processing webhook' });
  }
});

/**
 * After an order is paid:
 * 1. Auto-generate a referral code for the customer (if they don't have one yet) and email it.
 * 2. If a referral code was used on this order (referral_code_used is set):
 *    - Record the redemption (idempotent).
 *    - Issue the referrer a single-use $20 credit code and email them.
 */
async function handleReferralOnPayment(order) {
  const customerEmail = order.customer_email;
  if (!customerEmail) return;

  // Step 1: give the customer their own referral code
  const ownCode = await getOrCreateReferralCode(customerEmail);
  // Send the code email only the first time (uses_count reflects prior redemptions, not whether email was sent;
  // we check if this is a fresh code by seeing if created_at is very recent — within 5 seconds)
  const isNewCode = ownCode && (Date.now() - new Date(ownCode.created_at).getTime() < 10000);
  if (isNewCode) {
    await sendReferralCodeEmail({
      email: customerEmail,
      name: order.customer_name || null,
      code: ownCode.code,
    });
  }

  // Step 2: process the referral code that was used on this order
  const usedCode = order.referral_code_used;
  if (!usedCode) return;

  // Idempotency: skip if already recorded
  const existing = await getRedemptionByOrderId(order.id);
  if (existing) return;

  const referralRow = await getReferralCodeByCode(usedCode);
  if (!referralRow) return;

  await recordRedemption(referralRow.id, customerEmail, order.id, 2000);

  // Issue a single-use $20 credit code for the referrer
  const creditCode = await createSingleUseCreditCode(referralRow.owner_email);

  if (!creditCode) {
    console.error('[webhooks] Failed to generate credit code for referrer:', referralRow.owner_email);
    return;
  }

  await sendReferrerCreditEmail({
    email: referralRow.owner_email,
    name: null, // referrer name not stored in referral_codes
    creditCode,
  });

  console.log(`[webhooks] Referral processed: referee=${customerEmail}, referrer=${referralRow.owner_email}, creditCode=${creditCode}`);
}

module.exports = router;