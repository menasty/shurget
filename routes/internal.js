// routes/internal.js — Internal API endpoints called by background cron agents
// All routes require the X-Internal-Key header to match INTERNAL_API_KEY env var.
// These are NOT public — they are called only by the Perplexity cron agents.

const express  = require('express');
const router   = express.Router();
const { pool } = require('../db/index');
const {
  assignDriverToOrder,
  getOrderById,
  getPendingReviewEmails,
  markReviewEmailSent,
} = require('../db/orders');
const {
  activateDriver,
  updateBackgroundCheckStatus,
} = require('../db/drivers');
const {
  sendDriverNewJobAlert,
  sendDriverAssignedEmail,
  sendDriverApplicationConfirmation,
  sendPostDeliveryReviewEmail,
} = require('../services/email');
const { getOrCreateReferralCode } = require('../db/referrals');
const { generateRatingToken } = require('../services/rating-token');

// ─── Auth middleware ──────────────────────────────────────────────────────────

const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
if (!INTERNAL_KEY) {
  console.error('[FATAL] INTERNAL_API_KEY env var is not set. Internal API routes will reject all requests.');
}

function requireInternalKey(req, res, next) {
  const key = req.headers['x-internal-key'];
  if (!key || key !== INTERNAL_KEY) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

router.use(requireInternalKey);

// ─── POST /api/internal/dispatch-notify ──────────────────────────────────────
// Called by auto-dispatch cron after a successful DB assignment.
// Sends the driver their job alert email.

router.post('/dispatch-notify', async (req, res) => {
  const { orderId, driverId, driverEmail, driverName, itemType,
          pickupAddress, dropoffAddress, priceTotal } = req.body || {};

  if (!orderId || !driverEmail) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  const appUrl = process.env.APP_URL || 'https://shurget.onrender.com';

  try {
    await sendDriverNewJobAlert({
      driverEmail,
      driverName: driverName || 'Driver',
      orderId,
      itemType: itemType || 'delivery',
      pickupAddress:  pickupAddress || '',
      dropoffAddress: dropoffAddress || '',
      priceTotal:     parseFloat(priceTotal) || 0,
      claimUrl:       `${appUrl}/driver/jobs/${orderId}`,
    });
    console.log(`[internal] dispatch-notify: driver alert sent for order ${orderId} → ${driverEmail}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[internal] dispatch-notify email failed:', e.message);
    // Non-fatal — assignment already in DB
    res.json({ ok: true, warning: 'Email failed but assignment stands' });
  }
});

// ─── POST /api/internal/customer-assigned-notify ─────────────────────────────
// Called by auto-dispatch cron to notify the customer their driver is assigned.

router.post('/customer-assigned-notify', async (req, res) => {
  const { orderId } = req.body || {};
  if (!orderId) return res.status(400).json({ ok: false, error: 'Missing orderId' });

  try {
    const order = await getOrderById(orderId);
    if (order && order.customer_email) {
      await sendDriverAssignedEmail(order);
      console.log(`[internal] customer-assigned-notify: sent for order ${orderId}`);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[internal] customer-assigned-notify failed:', e.message);
    res.json({ ok: true, warning: 'Customer email failed' });
  }
});

// ─── POST /api/internal/driver-onboarding ────────────────────────────────────
// Called by onboarding pipeline cron.
// type: 'onboarding_welcome' | 'bgcheck_cleared' | 'bgcheck_failed'

router.post('/driver-onboarding', async (req, res) => {
  const { type, driverId, name, email } = req.body || {};

  if (!type || !driverId || !email) {
    return res.status(400).json({ ok: false, error: 'Missing required fields' });
  }

  try {
    if (type === 'onboarding_welcome') {
      // Send application confirmation email (re-uses existing email function)
      await sendDriverApplicationConfirmation({
        name:          name || 'Driver',
        email,
        applicationId: driverId,
      });
      console.log(`[internal] onboarding_welcome sent to driver ${driverId}`);

    } else if (type === 'bgcheck_cleared') {
      // Activate the driver (activateDriver also assigns referral code)
      await activateDriver(driverId);
      // Send a cleared/welcome-to-the-team email
      // Re-use application confirmation email as a welcome stand-in until
      // a dedicated activation email template is added
      await sendDriverApplicationConfirmation({
        name:          name || 'Driver',
        email,
        applicationId: driverId,
      });
      console.log(`[internal] bgcheck_cleared: driver ${driverId} activated`);

    } else if (type === 'bgcheck_failed') {
      // Update status (DB already updated by cron, this just sends the email)
      // For now log — a dedicated rejection email template should be added
      console.log(`[internal] bgcheck_failed: driver ${driverId} rejected, email queued`);
      // TODO: add sendDriverRejectionEmail() to services/email.js
    }

    res.json({ ok: true, type });
  } catch (e) {
    console.error(`[internal] driver-onboarding ${type} failed:`, e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── GET /api/internal/bgcheck-status ────────────────────────────────────────
// Called by onboarding pipeline cron to check a driver's bgcheck result.
// Currently reads from the local DB. When Checkr webhooks are wired up,
// this endpoint will proxy to Checkr's API using the candidate ID.

router.get('/bgcheck-status', async (req, res) => {
  const driverId = parseInt(req.query.driverId, 10);
  if (!driverId) return res.status(400).json({ ok: false, error: 'Missing driverId' });

  try {
    const { rows } = await pool.query(
      'SELECT background_check_status, bgcheck_candidate_id FROM driver_applications WHERE id = $1',
      [driverId]
    );
    const driver = rows[0];
    if (!driver) return res.status(404).json({ ok: false, error: 'Driver not found' });

    // Map internal status to Checkr-style status for the cron
    const statusMap = {
      cleared:     'clear',
      failed:      'consider',
      pending:     'pending',
      initiated:   'pending',
      in_progress: 'pending',
    };
    const status = statusMap[driver.background_check_status] || 'pending';
    res.json({ ok: true, status, raw: driver.background_check_status, candidateId: driver.bgcheck_candidate_id });
  } catch (e) {
    console.error('[internal] bgcheck-status failed:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── POST /api/internal/send-review-requests ─────────────────────────────────
// Called by the review-email cron agent (every ~15 min). Processes orders
// whose scheduled_review_email_at is due and haven't been sent yet, reusing
// the exact same pipeline as jobs/review-email-worker.js: rating token via
// services/rating-token.js, /rate/:id link, driver_ratings-backed review flow.
// Idempotent: markReviewEmailSent claims each row before sending so retries
// and overlapping cron runs can't double-send.

router.post('/send-review-requests', async (req, res) => {
  const pending = await getPendingReviewEmails(20).catch(err => {
    console.error('[internal] send-review-requests: query failed:', err.message);
    return [];
  });

  let processed = 0;
  const errors = [];

  for (const order of pending) {
    try {
      // Claim the send slot first (idempotency) — if another run races, only one wins.
      const claimed = await markReviewEmailSent(order.id);
      if (!claimed) continue;

      const refRow = await getOrCreateReferralCode(order.customer_email);
      const referralCode      = refRow.code;
      const appUrl             = process.env.APP_URL || 'https://shurget.com';
      const referralShareLink  = `${appUrl}/book?ref=${referralCode}&utm_source=referral&utm_medium=email&utm_campaign=customer_referral`;

      const token      = generateRatingToken(order.id);
      const ratingLink = `${appUrl}/rate/${order.id}?token=${token}`;

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

      processed++;
      console.log(`[internal] send-review-requests: sent review email for order #${order.id} to ${order.customer_email}`);
    } catch (e) {
      errors.push({ orderId: order.id, error: e.message });
      console.error(`[internal] send-review-requests: failed for order #${order.id}:`, e.message);
    }
  }

  res.json({ ok: true, processed, errors });
});

module.exports = router;
