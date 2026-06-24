// routes/reviews.js — Driver rating submission
// GET  /rate/:orderId       — render rating page (validates token, checks if already rated)
// POST /api/reviews/:orderId — submit a rating
// Owns: rating page render + API endpoint for submitting ratings
// Does NOT own: token generation (services/rating-token.js), DB writes (db/ratings.js)

const express = require('express');
const router  = express.Router();
const { getOrderById }   = require('../db/orders');
const { createRating, getRatingByOrderId } = require('../db/ratings');
const { verifyRatingToken } = require('../services/rating-token');

/**
 * GET /rate/:orderId?token=TOKEN
 * Render the rating page. Token validation happens here; invalid tokens get a 403.
 * Already-rated orders show a "thanks" screen.
 */
router.get('/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const token   = req.query.token || '';

  if (!orderId || isNaN(orderId)) {
    return res.status(400).render('error', { message: 'Invalid order ID.' });
  }

  const { valid } = verifyRatingToken(token);
  if (!valid) {
    return res.status(403).render('error', { message: 'This rating link has expired or is invalid. Links are valid for 14 days.' });
  }

  const order = await getOrderById(orderId);
  if (!order) return res.status(404).render('404');

  const existing = await getRatingByOrderId(orderId);

  res.render('rate-driver', {
    order,
    token,
    alreadyRated: !!existing,
    existingRating: existing || null,
    driverFirstName: order.driver_name ? order.driver_name.split(' ')[0] : 'Your driver',
  });
});

/**
 * POST /api/reviews/:orderId
 * Submit a 1–5 star rating for the driver. Idempotent (DB unique index on order_id).
 */
router.post('/:orderId', async (req, res) => {
  const orderId = parseInt(req.params.orderId, 10);
  const token   = req.body.token || '';

  if (!orderId || isNaN(orderId)) {
    return res.status(400).json({ error: 'Invalid order ID' });
  }

  const { valid, orderId: tokenOrderId } = verifyRatingToken(token);
  // Verify token matches the order being rated
  if (!valid || tokenOrderId !== orderId) {
    return res.status(403).json({ error: 'Invalid or expired rating token' });
  }

  const rating = parseInt(req.body.rating, 10);
  if (!rating || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Rating must be 1–5' });
  }

  const order = await getOrderById(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const row = await createRating({
    orderId,
    driverId: order.driver_id || null,
    rating,
    comment:   req.body.comment || null,
    source:    'email',
    tokenUsed: token,
  });

  if (!row) {
    // Already rated — idempotent success
    return res.json({ success: true, alreadyRated: true });
  }

  // Redirect GET requests (form post) back to the page with a thank-you flag
  if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
    return res.redirect(`/rate/${orderId}?token=${encodeURIComponent(token)}&rated=1`);
  }
  res.json({ success: true });
});

/**
 * GET /driver/dispute/new — dispute form (driver contests a rating).
 * Accessible via link from rate-driver.ejs.
 * Driver authenticated via email query param (simple auth for self-service).
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
  if (orderId) {
    const existing = await getRatingByOrderId(orderId);
    if (existing) rating = existing.rating;
  }

  res.render('driver-dispute', {
    order,
    rating,
    driverEmail: email,
    submitted,
  });
});

/**
 * POST /api/driver/disputes — driver submits a dispute for a rating.
 * No token required — driver identifies themselves by email + orderId.
 */
router.post('/api/driver/disputes', async (req, res) => {
  const { orderId, driverEmail, reason, comment } = req.body;

  if (!orderId || !driverEmail || !reason) {
    return res.status(400).json({ error: 'orderId, driverEmail, and reason are required' });
  }

  const driver = await getDriverByEmail(driverEmail);
  if (!driver) {
    return res.status(404).json({ error: 'Driver not found' });
  }

  const order = await getOrderById(parseInt(orderId, 10));
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  // Get rating if it exists
  let rating = null;
  const existing = await getRatingByOrderId(parseInt(orderId, 10));
  if (existing) rating = existing.rating;

  const dispute = await createDispute({
    orderId: parseInt(orderId, 10),
    driverId: driver.id,
    rating,
    comment,
    reason: reason.trim(),
  });

  if (!dispute) {
    return res.json({ success: true, note: 'Dispute already on record for this order.' });
  }

  res.json({ success: true });
});

module.exports = router;
