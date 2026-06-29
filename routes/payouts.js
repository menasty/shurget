// routes/payouts.js — Driver Stripe Connect onboarding and earnings (session-based auth)
// GET  /driver/payouts                — Connect bank page
// POST /api/driver/payouts/connect    — Create/refresh Connect account
// GET  /driver/earnings               — Earnings history
// GET  /api/driver/payouts/status     — JSON account status

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { getDriverByEmail, saveStripeAccountId } = require('../db/drivers');
const { getPayoutsByDriver, getDriverEarningsSummary } = require('../db/orders');
const {
  createConnectAccount,
  createAccountLink,
  getAccountStatus,
} = require('../services/stripe-connect');

// ── Session cookie helpers (same COOKIE_SECRET as driver.js) ─────────────────
const DRIVER_COOKIE = 'dr_session';
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

function unsignId(cookie) {
  if (!cookie || typeof cookie !== 'string') return null;
  const dot = cookie.lastIndexOf('.');
  if (dot === -1) return null;
  const id  = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(id);
  if (hmac.digest('base64url') !== sig) return null;
  return id;
}

async function requireDriver(req, res, next) {
  const cookie = req.cookies?.[DRIVER_COOKIE];
  if (!unsignId(cookie)) return res.redirect('/driver/login');
  const emailCookie = req.cookies?.['dr_email'];
  if (!emailCookie) return res.redirect('/driver/login');
  const email = Buffer.from(emailCookie, 'base64').toString('utf8');
  const driver = await getDriverByEmail(email).catch(() => null);
  if (!driver) return res.redirect('/driver/login');
  req.driver = driver;
  next();
}

// ── Helper: build absolute base URL ──────────────────────────────────────────
function baseUrl(req) {
  const host  = req.headers['x-original-host'] || req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${host}`;
}

// GET /driver/payouts — payout connection page
router.get('/driver/payouts', requireDriver, async (req, res) => {
  const status = await getAccountStatus(req.driver.stripe_account_id).catch(() => 'not_connected');
  res.render('driver-payouts', { driver: req.driver, payoutStatus: status });
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
    const base = process.env.APP_URL || baseUrl(req);
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
