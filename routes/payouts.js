// routes/payouts.js — Driver Stripe Connect Express onboarding and earnings view
// GET  /driver/payouts                  — Connect bank page (show status + onboard button)
// POST /api/driver/payouts/connect      — Create/refresh Connect account + return onboarding URL
// GET  /driver/earnings                 — Earnings history page
// GET  /api/driver/payouts/status       — JSON account status check
// Does NOT own: order creation, Stripe Checkout, webhook verification.

const express = require('express');
const router = express.Router();
const { getDriverByEmail } = require('../db/drivers');
const { saveStripeAccountId } = require('../db/drivers');
const { getPayoutsByDriver, getDriverEarningsSummary } = require('../db/orders');
const {
  createConnectAccount,
  createAccountLink,
  getAccountStatus,
} = require('../services/stripe-connect');

// ── Auth middleware (email-param based, same pattern as driver.js) ──
async function requireDriver(req, res, next) {
  const email = req.query.email || req.body.email;
  if (!email) return res.status(401).json({ error: 'Driver email is required' });
  const driver = await getDriverByEmail(email);
  if (!driver) {
    return res.status(401).json({ error: 'Driver not found or not approved.' });
  }
  req.driver = driver;
  next();
}

// ── Helper: build absolute base URL ──
function baseUrl(req) {
  // Honor proxy headers set by Render / Polsia's proxy layer.
  const host =
    req.headers['x-original-host'] ||
    req.headers['x-forwarded-host'] ||
    req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${host}`;
}

// GET /driver/payouts?email=...
// Renders the payout connection page with current account status.
router.get('/driver/payouts', async (req, res) => {
  const email = req.query.email;
  const driver = email ? await getDriverByEmail(email) : null;
  if (!driver) {
    return res.redirect('/driver/jobs');
  }
  const status = await getAccountStatus(driver.stripe_account_id);
  res.render('driver-payouts', { driver, payoutStatus: status, email });
});

// GET /driver/earnings?email=...
// Earnings history + summary for a driver.
router.get('/driver/earnings', async (req, res) => {
  const email = req.query.email;
  const driver = email ? await getDriverByEmail(email) : null;
  if (!driver) {
    return res.redirect('/driver/jobs');
  }
  const [payouts, summary] = await Promise.all([
    getPayoutsByDriver(driver.id),
    getDriverEarningsSummary(driver.id),
  ]);
  res.render('driver-earnings', { driver, payouts, summary, email });
});

// POST /api/driver/payouts/connect?email=...
// Creates or refreshes the Connect Express account and returns an onboarding URL.
router.post('/api/driver/payouts/connect', requireDriver, async (req, res) => {
  const driver = req.driver;
  try {
    let stripeAccountId = driver.stripe_account_id;

    // Create account if this driver doesn't have one yet.
    if (!stripeAccountId) {
      const account = await createConnectAccount(driver);
      stripeAccountId = account.id;
      await saveStripeAccountId(driver.id, stripeAccountId);
    }

    const base = baseUrl(req);
    const link = await createAccountLink(stripeAccountId, {
      refreshUrl: `${base}/driver/payouts?email=${encodeURIComponent(driver.email)}&refresh=1`,
      returnUrl:  `${base}/driver/payouts?email=${encodeURIComponent(driver.email)}&connected=1`,
    });

    res.json({ url: link.url });
  } catch (err) {
    console.error('[payouts] createAccountLink error:', err);
    res.status(500).json({ error: 'Failed to start payout setup. Please try again.' });
  }
});

// GET /api/driver/payouts/status?email=...
// Returns JSON { status: 'not_connected' | 'pending' | 'ready' }
router.get('/api/driver/payouts/status', requireDriver, async (req, res) => {
  try {
    const status = await getAccountStatus(req.driver.stripe_account_id);
    res.json({ status });
  } catch (err) {
    console.error('[payouts] status check error:', err);
    res.status(500).json({ error: 'Failed to check payout status' });
  }
});

module.exports = router;
