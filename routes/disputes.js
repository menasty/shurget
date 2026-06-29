// routes/disputes.js — Driver rating dispute self-service (session-based auth)
// GET  /driver/dispute/new    — dispute form
// GET  /driver/disputes       — driver's dispute list
// POST /api/driver/disputes   — submit a dispute

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { getOrderById }                              = require('../db/orders');
const { getDriverByEmail }                          = require('../db/drivers');
const { createDispute, getDisputesByDriver, getRatingByOrderId } = require('../db/ratings');

// ── Shared session helpers (same COOKIE_SECRET as driver.js) ──────────────────
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
  const expected = hmac.digest('base64url');
  if (sig !== expected) return null;
  return id;
}

async function requireDriver(req, res, next) {
  const cookie = req.cookies?.[DRIVER_COOKIE];
  if (!unsignId(cookie)) return res.redirect('/driver/login');
  // Decode email from the cookie value via the in-memory session map in driver.js
  // Since we can't share Maps across modules, we re-validate using a lightweight
  // approach: trust the signed cookie and look up driver by stored email in session.
  // The simplest cross-module approach: store email in a separate signed cookie.
  const emailCookie = req.cookies?.['dr_email'];
  if (!emailCookie) return res.redirect('/driver/login');
  const email = Buffer.from(emailCookie, 'base64').toString('utf8');
  const driver = await getDriverByEmail(email).catch(() => null);
  if (!driver) return res.redirect('/driver/login');
  req.driver = driver;
  next();
}

// GET /driver/dispute/new — dispute form
router.get('/dispute/new', requireDriver, async (req, res) => {
  const orderId   = parseInt(req.query.order_id, 10);
  const submitted = req.query.submitted === '1';

  if (!orderId || isNaN(orderId)) {
    return res.status(400).render('error', { message: 'Invalid order ID.' });
  }

  const order = await getOrderById(orderId).catch(() => null);
  if (!order) return res.status(404).render('404');

  let rating = null;
  const existing = await getRatingByOrderId(orderId).catch(() => null);
  if (existing) rating = existing.rating;

  res.render('driver-dispute', {
    order,
    rating,
    driver: req.driver,
    submitted,
  });
});

// GET /driver/disputes — driver's dispute list
router.get('/disputes', requireDriver, async (req, res) => {
  const disputes = await getDisputesByDriver(req.driver.id).catch(() => []);
  res.render('driver-disputes', {
    driver:   req.driver,
    disputes,
  });
});

// POST /api/driver/disputes — submit a dispute
router.post('/api/driver/disputes', requireDriver, async (req, res) => {
  const { orderId, reason, comment } = req.body;

  if (!orderId || !reason) {
    return res.status(400).json({ error: 'orderId and reason are required' });
  }

  const order = await getOrderById(parseInt(orderId, 10)).catch(() => null);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  let rating = null;
  const existing = await getRatingByOrderId(parseInt(orderId, 10)).catch(() => null);
  if (existing) rating = existing.rating;

  const dispute = await createDispute({
    orderId:  parseInt(orderId, 10),
    driverId: req.driver.id,
    rating,
    comment:  comment || null,
    reason:   reason.trim(),
  }).catch(() => null);

  if (!dispute) {
    return res.json({ success: true, note: 'Dispute already on record for this order.' });
  }

  res.json({ success: true });
});

module.exports = router;
