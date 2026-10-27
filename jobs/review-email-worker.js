// jobs/review-email-worker.js — Send queued post-delivery review emails
// Run by .toml [[crons]] every 15 minutes.
// Scans orders where scheduled_review_email_at <= NOW() and review_email_sent_at IS NULL.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// DATABASE_URL must be set — same pool as the main app
if (!process.env.DATABASE_URL) {
  console.error('[review-worker] DATABASE_URL not set — exiting');
  process.exit(1);
}

const { getPendingReviewEmails, markReviewEmailSent } = require('../db/orders');
const { sendPostDeliveryReviewEmail }                  = require('../services/email');
const { getReferralCodeByEmail, getOrCreateReferralCode } = require('../db/referrals');
const { generateRatingToken }                          = require('../services/rating-token');

const APP_URL = process.env.APP_URL || 'https://shurgetapp.com';

async function run() {
  const pending = await getPendingReviewEmails(50);
  console.log(`[review-worker] ${pending.length} review email(s) to send`);

  for (const order of pending) {
    try {
      // Claim the send slot first (idempotency) — if another worker races, only one wins
      const claimed = await markReviewEmailSent(order.id);
      if (!claimed) {
        // Another worker already sent — skip silently
        continue;
      }

      // Fetch or create the customer's referral code
      const refRow = await getOrCreateReferralCode(order.customer_email);
      const referralCode      = refRow.code;
      const referralShareLink = `${APP_URL}/book?ref=${referralCode}&utm_source=referral&utm_medium=email&utm_campaign=customer_referral`;

      // Generate the one-time rating token
      const token      = generateRatingToken(order.id);
      const ratingLink = `${APP_URL}/rate/${order.id}?token=${token}`;

      // Driver first name from the joined driver_applications row
      const driverFirstName = order.driver_first_name_full
        ? order.driver_first_name_full.split(' ')[0]
        : (order.driver_name ? order.driver_name.split(' ')[0] : 'your driver');

      await sendPostDeliveryReviewEmail({
        order,
        driverFirstName,
        ratingLink,
        referralCode,
        referralShareLink,
      });

      console.log(`[review-worker] Sent review email for order #${order.id} to ${order.customer_email}`);
    } catch (err) {
      // Don't let one failure block others; the row stays unsent (review_email_sent_at still NULL)
      // because we only set it after a successful send above.
      // NOTE: markReviewEmailSent sets the timestamp before the send attempt to prevent double-send.
      // On failure, the email won't be retried automatically — acceptable tradeoff for idempotency.
      console.error(`[review-worker] Failed for order #${order.id}:`, err.message);
    }
  }

  console.log('[review-worker] Done');
  process.exit(0);
}

run().catch(err => {
  console.error('[review-worker] Fatal:', err);
  process.exit(1);
});
