// services/stripe-connect.js — Stripe Connect Express: driver onboarding + order payouts
// Owns: account creation, account link generation, account status check, transfer creation.
// Does NOT own: Stripe Checkout sessions (services/stripe.js), webhook verification (routes/webhooks.js).

const Stripe = require('stripe');

// Lazy-init so tests / environments without the key don't crash at require time.
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set — cannot use Stripe Connect');
  }
  return Stripe(process.env.STRIPE_SECRET_KEY);
}

const PLATFORM_FEE_RATE = 0.15; // 15% stays with Shurget

/**
 * Create a Stripe Connect Express account for a driver.
 * Returns the new account object; caller should persist account.id to driver_applications.
 */
async function createConnectAccount(driver) {
  const stripe = getStripe();
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: driver.email,
    capabilities: {
      transfers: { requested: true },
    },
    business_type: 'individual',
    metadata: { driver_id: String(driver.id), driver_name: driver.name },
  });
  return account;
}

/**
 * Generate an account link so the driver can complete Express onboarding.
 * refreshUrl and returnUrl must be absolute URLs pointing back to /driver/payouts.
 */
async function createAccountLink(stripeAccountId, { refreshUrl, returnUrl }) {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return link; // { url, expires_at }
}

/**
 * Retrieve a Connect account and return a simplified status string:
 *   'not_connected'  — account does not exist yet
 *   'pending'        — account exists but onboarding not complete
 *   'ready'          — charges_enabled and payouts_enabled
 */
async function getAccountStatus(stripeAccountId) {
  if (!stripeAccountId) return 'not_connected';
  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(stripeAccountId);
    if (account.charges_enabled && account.payouts_enabled) return 'ready';
    return 'pending';
  } catch (err) {
    // Account may have been deleted or key changed
    console.error('[stripe-connect] getAccountStatus error:', err.message);
    return 'not_connected';
  }
}

/**
 * Transfer driver payout for a delivered order.
 * payout = price_total * (1 - PLATFORM_FEE_RATE), rounded to cents.
 * Returns { transfer, amountCents } on success; throws on failure.
 */
async function payoutDriver(order, stripeAccountId) {
  if (!stripeAccountId) {
    throw new Error('Driver has no Stripe account — cannot payout');
  }
  const stripe = getStripe();
  const grossCents = Math.round((order.price_total || 0) * 100);
  const amountCents = Math.round(grossCents * (1 - PLATFORM_FEE_RATE));

  const transfer = await stripe.transfers.create({
    amount: amountCents,
    currency: 'usd',
    destination: stripeAccountId,
    transfer_group: 'order_' + order.id,
    metadata: {
      order_id: String(order.id),
      customer_email: order.customer_email || '',
      item_type: order.item_type || '',
    },
  });

  return { transfer, amountCents };
}

/**
 * Transfer a fixed driver-to-driver referral bounty ($50 = 5000 cents).
 * Called when a referred driver completes their 3rd haul.
 * Uses a unique idempotency key scoped to the referred driver ID so duplicate calls are safe.
 */
async function payoutDriverReferralBounty(referrerStripeAccountId, amountCents, referredDriverId) {
  if (!referrerStripeAccountId) {
    throw new Error('Referrer has no Stripe account — cannot pay bounty');
  }
  const stripe = getStripe();
  const transfer = await stripe.transfers.create({
    amount: amountCents,
    currency: 'usd',
    destination: referrerStripeAccountId,
    transfer_group: 'driver_referral_bounty',
    metadata: {
      type: 'driver_referral_bounty',
      referred_driver_id: String(referredDriverId),
      amount_dollars: String((amountCents / 100).toFixed(2)),
    },
  }, {
    idempotencyKey: `driver_referral_bounty_${referredDriverId}`,
  });
  return transfer;
}

// ─── Partner Connect ─────────────────────────────────────────────────────────

/**
 * Create a Stripe Connect Express account for a partner.
 * Returns the new account object; caller persists account.id to partners.stripe_account_id.
 */
async function createPartnerConnectAccount(partner) {
  const stripe = getStripe();
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'US',
    email: partner.contact_email,
    capabilities: {
      transfers: { requested: true },
    },
    business_type: 'individual',
    metadata: { partner_id: String(partner.id), partner_slug: partner.slug },
  });
  return account;
}

/**
 * Generate an account link so the partner can complete Express onboarding.
 */
async function createPartnerAccountLink(stripeAccountId, { refreshUrl, returnUrl }) {
  const stripe = getStripe();
  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return link;
}

/**
 * Pay out a partner's accumulated commission (threshold: ≥ $25 / 2500 cents).
 * Commission = price_total * PLATFORM_FEE_RATE (15%) * partner.commission_rate (default 10%)
 * So for a $100 order: $100 * 0.15 * 0.10 = $1.50.
 * Idempotent via `partner_payout_{partnerId}_{orderId}` key so safe on retry.
 * Returns { transfer, amountCents } on success; null if below threshold or no Stripe account.
 */
async function payoutPartnerCommission(partner, amountCents) {
  if (!partner.stripe_account_id) {
    console.warn('[stripe-connect] Partner has no Stripe account — skipping payout');
    return null;
  }
  if (amountCents < 2500) {
    console.warn('[stripe-connect] Commission below $25 threshold — skipping payout');
    return null;
  }

  const stripe = getStripe();
  const transfer = await stripe.transfers.create({
    amount: amountCents,
    currency: 'usd',
    destination: partner.stripe_account_id,
    transfer_group: 'partner_commission',
    metadata: {
      type: 'partner_commission',
      partner_id: String(partner.id),
      partner_slug: partner.slug,
      amount_dollars: String((amountCents / 100).toFixed(2)),
    },
  }, {
    idempotencyKey: `partner_payout_${partner.id}`,
  });

  return { transfer, amountCents };
}

module.exports = {
  createConnectAccount,
  createAccountLink,
  getAccountStatus,
  payoutDriver,
  payoutDriverReferralBounty,
  createPartnerConnectAccount,
  createPartnerAccountLink,
  payoutPartnerCommission,
  PLATFORM_FEE_RATE,
};
