// routes/payouts.js — Driver Stripe Connect onboarding and earnings (session-based auth)
// GET  /driver/payouts                — Connect bank page
// POST /api/driver/payouts/connect    — Create/refresh Connect account
// GET  /driver/earnings               — Earnings history
// GET  /api/driver/payouts/status     — JSON account status

const express  = require('express');
const router   = express.Router();
const { saveStripeAccountId } = require('../db/drivers');
const { getPayoutsByDriver, getDriverEarningsSummary } = require('../db/orders');
const {
  createConnectAccount,
  createAccountLink,
  getAccountStatus,
} = require('../services/stripe-connect');

// ── Driver auth — shared server-side session (middleware/driver-session.js).
// Identity is resolved from the session store, never from client-supplied
// cookies. (Previously this trusted an unsigned base64 `dr_email` cookie,
// which let any driver impersonate any other driver.)
const { requireDriverSession: requireDriver } = require('../middleware/driver-session');

// ── Helper: build absolute base URL ──────────────────────────────────────────
function baseUrl(req) {
  const host  = req.headers['x-original-host'] || req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${host}`;
}

// GET /driver/payouts — payout connection page
router.get('/driver/payouts', requireDriver, async (req, res) => {
  const status = await getAccountStatus(req.driver.stripe_account_id).catch(() => 'not_connected');
  res.render('driver-payouts', {
    driver:       req.driver,
    payoutStatus: status,
    connected:    req.query.connected === '1',
  });
});

// GET /driver/earnings — earnings history
router.get('/driver/earnings', requireDriver, async (req, res) => {
  const [payouts, summary] = await Promise.all([
    getPayoutsByDriver(req.driver.id).catch(() => []),
    getDriverEarningsSummary(req.driver.id).catch(() => ({})),
  ]);
  res.render('driver-earnings', { driver: req.driver, payouts, summary });
});

// POST /api/driver/payouts/connect — create/refresh Stripe Connect account
router.post('/api/driver/payouts/connect', requireDriver, async (req, res) => {
  try {
    let stripeAccountId = req.driver.stripe_account_id;
    if (!stripeAccountId) {
      const account = await createConnectAccount(req.driver);
      stripeAccountId = account.id;
      await saveStripeAccountId(req.driver.id, stripeAccountId);
    }
    // Return the driver to the same domain they started from (whitelisted), else APP_URL
    const ALLOWED_HOSTS = ['shurget.com', 'www.shurget.com', 'shurgetapp.com', 'www.shurgetapp.com'];
    const reqHost = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
    const base = ALLOWED_HOSTS.includes(reqHost)
      ? `https://${reqHost.replace(/^www\./, '')}`
      : (process.env.APP_URL || baseUrl(req));
    const link = await createAccountLink(stripeAccountId, {
      refreshUrl: `${base}/driver/payouts`,
      returnUrl:  `${base}/driver/payouts?connected=1`,
    });
    res.json({ url: link.url });
  } catch (err) {
    console.error('[payouts] createAccountLink error:', err.message);
    res.status(500).json({ error: 'Failed to start payout setup. Please try again.' });
  }
});

// GET /api/driver/payouts/status — JSON status check
router.get('/api/driver/payouts/status', requireDriver, async (req, res) => {
  try {
    const status = await getAccountStatus(req.driver.stripe_account_id);
    res.json({ status });
  } catch (err) {
    console.error('[payouts] status check error:', err.message);
    res.status(500).json({ error: 'Failed to check payout status' });
  }
});

module.exports = router;
