// routes/driver-api.js — Driver trip-status + GPS API (session-authenticated)
// Mounted at /api/driver. Owns: my-jobs JSON, trip steps (start/arrived/loaded/deliver), location pings, decline.
// Auth is applied per-route so other /api/driver/* routers (payouts, disputes) pass through untouched.
const express = require('express');
const router = express.Router();
const db = require('../db/index');
const {
  getMyJobs, getOrderById, updateDriverLocation, declineJob,
  markStatusEmailSent, scheduleReviewEmail,
} = require('../db/orders');
const { apiAuth } = require('./driver');

async function ownOrder(req, res) {
  const id = parseInt(req.params.id, 10);
  const order = id ? await getOrderById(id) : null;
  if (!order || Number(order.driver_id) !== Number(req.driver.id)) {
    res.status(403).json({ error: 'Job not found or not assigned to you.' });
    return null;
  }
  return order;
}

router.get('/my-jobs', apiAuth, async (req, res) => {
  try {
    res.json({ jobs: await getMyJobs(req.driver.id) });
  } catch (e) {
    console.error('[driver-api] my-jobs:', e.message);
    res.status(500).json({ error: 'Failed to load jobs.' });
  }
});

// Trip state machine: assigned -> en_route -> arrived -> loaded -> delivered
const STEPS = {
  start:   { where: "status = 'assigned'",                                 set: "status = 'in_progress', driver_status = 'en_route'" },
  arrived: { where: "status = 'in_progress' AND driver_status = 'en_route'", set: "driver_status = 'arrived'" },
  loaded:  { where: "status = 'in_progress' AND driver_status = 'arrived'",  set: "driver_status = 'loaded'" },
  deliver: { where: "status = 'in_progress'",                              set: "status = 'delivered', driver_status = 'completed', delivered_at = NOW()" },
};

function notifyCustomer(step, order) {
  try {
    const email = require('../services/email');
    if (step === 'start') {
      markStatusEmailSent(order.id, 'en_route')
        .then(first => { if (first) return email.sendInTransitEmail(order); })
        .catch(e => console.error('[driver-api] en_route email:', e.message));
    }
    if (step === 'deliver') {
      const base = process.env.APP_URL || 'https://shurget.com';
      markStatusEmailSent(order.id, 'delivered')
        .then(first => { if (first) return email.sendDeliveredEmail(order, `${base}/rate/${order.id}`); })
        .catch(e => console.error('[driver-api] delivered email:', e.message));
      scheduleReviewEmail(order.id).catch(() => {});
    }
  } catch (e) {
    console.error('[driver-api] notify:', e.message);
  }
}

for (const [step, t] of Object.entries(STEPS)) {
  router.post(`/jobs/:id/${step}`, apiAuth, async (req, res) => {
    try {
      const order = await ownOrder(req, res);
      if (!order) return;
      const { rows } = await db.query(
        `UPDATE orders SET ${t.set}, updated_at = NOW()
          WHERE id = $1 AND driver_id = $2 AND ${t.where}
          RETURNING *`,
        [order.id, req.driver.id]
      );
      const updated = rows[0];
      if (!updated) {
        return res.status(409).json({ error: "That step isn't available for this job's current status. Refresh and try again." });
      }
      notifyCustomer(step, updated);
      res.json({ success: true, order: { id: updated.id, status: updated.status, driver_status: updated.driver_status } });
    } catch (e) {
      console.error(`[driver-api] ${step}:`, e.message);
      res.status(500).json({ error: 'Update failed — try again.' });
    }
  });
}

router.post('/jobs/:id/location', apiAuth, async (req, res) => {
  try {
    const order = await ownOrder(req, res);
    if (!order) return;
    const lat = Number(req.body?.lat), lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng must be numbers' });
    if (order.status !== 'in_progress') return res.json({ ok: true, ignored: true });
    const updated = await updateDriverLocation(order.id, lat, lng);
    res.json({ ok: true, updatedAt: updated && updated.driver_location_updated_at });
  } catch (e) {
    console.error('[driver-api] location:', e.message);
    res.status(500).json({ error: 'Failed to update location.' });
  }
});

router.post('/jobs/:id/decline', apiAuth, async (req, res) => {
  try {
    const r = await declineJob(parseInt(req.params.id, 10), req.driver.id);
    res.json({ success: !!r });
  } catch (e) {
    console.error('[driver-api] decline:', e.message);
    res.status(500).json({ error: 'Decline failed.' });
  }
});

module.exports = router;
