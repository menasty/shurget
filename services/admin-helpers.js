// services/admin-helpers.js — Admin-side helpers for order lifecycle events
// Owns: payout triggers, referral bounty checks, partner commission.
// Does NOT own: order CRUD (db/orders.js), driver queries (db/drivers.js).

const {
  getDriverById,
  countDeliveredOrdersForDriver,
  recordReferralBounty,
} = require('../db/drivers');
const {
  savePayoutTransfer,
  markPayoutFailed,
  scheduleReviewEmail,
} = require('../db/orders');
const { addCommission, getPartnerBySlug, deductCommission } = require('../db/partners');
const { payoutDriver, payoutDriverReferralBounty, payoutPartnerCommission } = require('./stripe-connect');
const { sendDriverReferralBountyEmail, sendDeliveredSms } = require('./email');

const PLATFORM_FEE_RATE = 0.15;

/**
 * Trigger driver payout for a delivered order. Fire-and-forget — order completion
 * is never blocked on payout success; failures are flagged for admin review.
 */
async function triggerPayout(order) {
  if (!order || !order.driver_id) return;
  try {
    const driver = await getDriverById(order.driver_id);
    if (!driver || !driver.stripe_account_id) {
      await markPayoutFailed(order.id);
      console.warn(`[payout] driver ${order.driver_id} has no Stripe account — order ${order.id} payout_status set to failed`);
      return;
    }
    const { transfer, amountCents } = await payoutDriver(order, driver.stripe_account_id);
    await savePayoutTransfer(order.id, transfer.id, amountCents);
    console.log(`[payout] transfer ${transfer.id} sent to driver ${driver.id} for order ${order.id} — $${(amountCents / 100).toFixed(2)}`);
  } catch (err) {
    await markPayoutFailed(order.id).catch(() => {});
    console.error(`[payout] transfer failed for order ${order.id}:`, err.message);
  }
}

/**
 * Check driver referral bounty eligibility after delivery.
 * Pays the referring driver $50 via Stripe Connect when the referred driver hits 3 completed hauls.
 * Idempotent: recordReferralBounty only updates if bounty not already paid.
 * Fire-and-forget — delivery is never blocked on bounty success.
 */
async function checkAndPayReferralBounty(deliveredOrder) {
  if (!deliveredOrder || !deliveredOrder.driver_id) return;
  try {
    const deliveredDriver = await getDriverById(deliveredOrder.driver_id);
    if (!deliveredDriver || !deliveredDriver.referred_by_driver_id) return;
    if (deliveredDriver.referral_bounty_paid_at) return;

    const completedCount = await countDeliveredOrdersForDriver(deliveredDriver.id);
    if (completedCount < 3) return;

    const referrer = await getDriverById(deliveredDriver.referred_by_driver_id);
    if (!referrer || !referrer.stripe_account_id) {
      console.warn(`[referral-bounty] referrer ${deliveredDriver.referred_by_driver_id} has no Stripe account — skipping`);
      return;
    }

    const BOUNTY_CENTS = 5000;
    const transfer = await payoutDriverReferralBounty(referrer.stripe_account_id, BOUNTY_CENTS, deliveredDriver.id);
    const recorded = await recordReferralBounty(deliveredDriver.id, transfer.id);
    if (!recorded) {
      console.log(`[referral-bounty] Already paid for driver ${deliveredDriver.id} — skipping duplicate`);
      return;
    }

    sendDriverReferralBountyEmail({
      referrerEmail: referrer.email,
      referrerName: referrer.name,
      referredDriverName: deliveredDriver.name,
      transferAmount: BOUNTY_CENTS,
    }).catch(err => console.error('[referral-bounty] Email error:', err.message));

    console.log(`[referral-bounty] $50 bounty paid — transfer ${transfer.id} to referrer ${referrer.id}`);
  } catch (err) {
    console.error(`[referral-bounty] Failed for order ${deliveredOrder.id}:`, err.message);
  }
}

/**
 * Add partner commission to balance when a widget-attributed order is delivered.
 * Fire-and-forget — order completion is never blocked on payout success.
 */
async function addPartnerCommission(order) {
  if (!order || !order.partner_slug) return;
  try {
    const partner = await getPartnerBySlug(order.partner_slug);
    if (!partner) return;

    const grossCents = Math.round((order.price_total || 0) * 100);
    const platformFee = grossCents * PLATFORM_FEE_RATE;
    const commissionCents = Math.round(platformFee * (partner.commission_rate || 0.1));
    if (commissionCents <= 0) return;

    await addCommission(partner.id, commissionCents);

    const updated = await getPartnerBySlug(order.partner_slug);
    if (updated && updated.commission_balance_cents >= 2500 && updated.stripe_account_id) {
      const result = await payoutPartnerCommission(updated, updated.commission_balance_cents);
      if (result) {
        await deductCommission(updated.id, result.amountCents);
        console.log(`[partner-commission] Payout of $${(result.amountCents / 100).toFixed(2)} sent to ${partner.slug}`);
      }
    }
  } catch (err) {
    console.error(`[partner-commission] Failed for order ${order.id}:`, err.message);
  }
}

module.exports = { triggerPayout, checkAndPayReferralBounty, addPartnerCommission };