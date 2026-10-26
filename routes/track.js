// routes/track.js — Order tracking page and status API
const express = require('express');
const router = express.Router();
const { getOrderById } = require('../db/orders');
const { requireTrackToken } = require('../middleware/track-token');
const { sendTrackingLinkEmail } = require('../services/email');

// POST /track/resend-link — email a fresh signed tracking link.
// Registered before GET /:id so the path is never swallowed as an order id.
// The response is always generic: it must not reveal whether an order/email
// pair exists, so it cannot be used to probe order/email pairs.
router.post('/resend-link', async (req, res) => {
  const orderId = parseInt(req.body.orderId, 10);
  const email = (req.body.email || '').trim().toLowerCase();
  if (orderId && email) {
    try {
      const order = await getOrderById(orderId);
      if (order && (order.customer_email || '').trim().toLowerCase() === email) {
        await sendTrackingLinkEmail(email, orderId);
      }
    } catch (err) {
      console.error('[track resend-link]', err);
    }
  }
  res.json({ ok: true, message: 'If that order and email match, a new tracking link is on its way.' });
});

// GET /track/:id — standalone tracking page
router.get('/:id', requireTrackToken, async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).render('404');
  res.render('track', { order, trackToken: req.trackToken || req.query.token || '' });
});

// GET /track/api/:id — lightweight status JSON for polling
router.get('/api/:id', requireTrackToken, async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({
    status: order.status,
    driver_name: order.driver_name,
    driver_phone: order.driver_phone,
    eta_minutes: order.eta_minutes,
    // GPS is shown ONLY while a driver is actively on the job. After delivery
    // (or before assignment) there is no live location to expose.
    driver_location: (order.driver_lat && order.driver_lng &&
      (order.status === 'assigned' || order.status === 'in_progress'))
      ? { lat: order.driver_lat, lng: order.driver_lng, updated_at: order.driver_location_updated_at }
      : null,
  });
});

module.exports = router;
