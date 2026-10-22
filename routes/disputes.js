// routes/disputes.js — Driver rating dispute self-service (session-based auth)
// GET  /driver/dispute/new    — dispute form
// GET  /driver/disputes       — driver's dispute list
// POST /api/driver/disputes   — submit a dispute

const express  = require('express');
const router   = express.Router();
const { getOrderById }                              = require('../db/orders');
const { createDispute, getDisputesByDriver, getRatingByOrderId } = require('../db/ratings');

// ── Driver auth — shared server-side session (middleware/driver-session.js).
// Identity is resolved from the session store, never from client-supplied
// cookies. (Previously this trusted an unsigned base64 `dr_email` cookie,
// which let any driver impersonate any other driver.)
const { requireDriverSession: requireDriver } = require('../middleware/driver-session');

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
