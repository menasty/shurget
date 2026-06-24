// routes/track.js — Order tracking page and status API
const express = require('express');
const router = express.Router();
const { getOrderById } = require('../db/orders');

// GET /track/:id — standalone tracking page
router.get('/:id', async (req, res) => {
  const { getOrderById } = require('../db/orders');
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).render('404');
  res.render('track', { order });
});

// GET /api/track/:id — lightweight status JSON for polling
router.get('/api/:id', async (req, res) => {
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({
    status: order.status,
    driver_name: order.driver_name,
    driver_phone: order.driver_phone,
    eta_minutes: order.eta_minutes,
    driver_location: (order.driver_lat && order.driver_lng)
      ? { lat: order.driver_lat, lng: order.driver_lng, updated_at: order.driver_location_updated_at }
      : null,
  });
});

module.exports = router;