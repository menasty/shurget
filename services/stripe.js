// services/stripe.js — Stripe Checkout integration
// Owns: creating Checkout sessions and redirecting to Stripe
// Does NOT own: webhook handling (future), payment processing logic

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// Lazily init — avoids crash when key is absent in dev
function getStripe() {
  if (!STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not set');
  }
  const Stripe = require('stripe');
  return new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2025-04-30.basil' });
}

const APP_URL = process.env.APP_URL || 'https://shurget-5.polsia.app';

/**
 * Create a Stripe Checkout session for an order.
 * Returns the session object (includes id and url).
 * If referralDiscountCents > 0, the `amount` passed in should already be the discounted total;
 * we also add a visible discount line item for clarity.
 */
async function createCheckoutSession({ orderId, amount, itemType, customerEmail, referralDiscountCents = 0, originalAmount = null }) {
  const stripe = getStripe();

  const lineItems = [
    {
      price_data: {
        currency: 'usd',
        unit_amount: Math.round((originalAmount || amount) * 100), // Stripe uses cents; show original price
        product_data: {
          name: `Shurget Delivery — ${capitalize(itemType)}`,
          description: 'Pickup truck delivery for oversized items',
        },
      },
      quantity: 1,
    },
  ];

  // Add a visible discount line item when a referral code was applied
  if (referralDiscountCents > 0) {
    lineItems.push({
      price_data: {
        currency: 'usd',
        unit_amount: -Math.abs(referralDiscountCents), // negative = discount
        product_data: {
          name: 'Referral Discount',
          description: '$20 off — referral code applied',
        },
      },
      quantity: 1,
    });
  }

  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    mode: 'payment',
    line_items: lineItems,
    customer_email: customerEmail || undefined,
    metadata: {
      orderId: String(orderId),
    },
    success_url: `${APP_URL}/confirmation/${orderId}?payment=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/confirmation/${orderId}?payment=cancelled`,
  });

  return session;
}

/**
 * Verify a Checkout session by ID and return its payment_status.
 * Returns null if session not found or key not set.
 */
async function getSessionStatus(sessionId) {
  if (!STRIPE_SECRET_KEY || !sessionId) return null;
  try {
    const stripe = getStripe();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return { paymentStatus: session.payment_status, customerEmail: session.customer_email };
  } catch {
    return null;
  }
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

module.exports = { createCheckoutSession, getSessionStatus };