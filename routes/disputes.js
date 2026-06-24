// routes/disputes.js — Driver rating dispute self-service
// GET  /driver/dispute/new       — dispute form (driver contests a rating)
// GET  /driver/disputes          — driver's dispute list with status
// POST /api/driver/disputes      — driver submits a dispute
// Owns: dispute form render + submission. Does NOT own: DB writes (db/ratings.js).

const express = require('express');
const router = express.Router();
const { getOrderById }   = require('../db/orders');
const { getDriverByEmail } = require('../db/drivers');
const { createDispute, getDisputesByDriver, getRatingByOrderId } = require('../db/ratings');

/**
 * GET /driver/dispute/new?order_id=X&email=Y — dispute form
 */
router.get('/dispute/new', async (req, res) => {
  const orderId   = parseInt(req.query.order_id, 10);
  const email     = req.query.email || '';
  const submitted = req.query.submitted === '1';

  if (!orderId || isNaN(orderId)) {
    return res.status(400).render('error', { message: 'Invalid order ID.' });
  }

  const order = await getOrderById(orderId);
  if (!order) return res.status(404).render('404');

  let rating = null;
  const existing = await getRatingByOrderId(orderId);
  if (existing) rating = existing.rating;

  res.render('driver-dispute', {
    order,
    rating,
    driverEmail: email,
    submitted,
  });
});

/**
 * GET /driver/disputes?email=X — driver's dispute list
 */
router.get('/disputes', async (req, res) => {
  const email = req.query.email || '';
  let driver = null;

  if (email) {
    driver = await getDriverByEmail(email);
  }

  let disputes = [];
  if (driver) {
    disputes = await getDisputesByDriver(driver.id);
  }

  res.render('driver-disputes', {
    driver,
    disputes,
    driverEmail: email,
  });
});

/**
 * POST /api/driver/disputes — driver submits a rating dispute
 */
router.post('/api/driver/disputes', async (req, res) => {
  const { orderId, driverEmail, reason, comment } = req.body;

  if (!orderId || !driverEmail || !reason) {
    return res.status(400).json({ error: 'orderId, driverEmail, and reason are required' });
  }

  const driver = await getDriverByEmail(driverEmail);
  if (!driver) {
    return res.status(404).json({ error: 'Driver not found. Use the email you signed up with.' });
  }

  const order = await getOrderById(parseInt(orderId, 10));
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  let rating = null;
  const existing = await getRatingByOrderId(parseInt(orderId, 10));
  if (existing) rating = existing.rating;

  const dispute = await createDispute({
    orderId: parseInt(orderId, 10),
    driverId: driver.id,
    rating,
    comment: comment || null,
    reason: reason.trim(),
  });

  if (!dispute) {
    return res.json({ success: true, note: 'Dispute already on record for this order.' });
  }

  res.json({ success: true });
});

module.exports = router;