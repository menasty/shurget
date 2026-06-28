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

module.exports = router;
