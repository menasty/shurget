// routes/driver.js — Driver jobs API (available feed, self-service claim, status updates)
// GET  /api/driver/jobs                 — list available jobs (payout-sorted, race-safe)
// POST /api/driver/jobs/:id/claim       — soft-claim a job (60s hold)
// POST /api/driver/jobs/:id/confirm     — confirm claimed job → permanent assignment
// POST /api/driver/jobs/:id/decline     — dismiss a job from feed
// GET  /api/driver/my-jobs             — list accepted jobs assigned to this driver
// POST /api/driver/jobs/:id/start       — mark en-route (fires email + SMS)
// POST /api/driver/jobs/:id/arrived     — mark arrived at pickup
// POST /api/driver/jobs/:id/loaded      — mark item loaded (sets in_progress)
// POST /api/driver/jobs/:id/deliver     — mark delivered (fires email + SMS + payout)
// Does NOT own: Stripe payout transfers (services/stripe-connect.js), SMS opt-outs (routes/sms.js)

const express = require('express');
const router = express.Router();
const { getDriverByEmail } = require('../db/drivers');
const {
  getAvailableJobs,
  claimJob,
  confirmClaim,
  releaseExpiredClaims,
  acceptJob,
  declineJob,
  getMyJobs,
  markJobStarted,
  markJobArrived,
  markJobLoaded,
  markJobDelivered,
  markStatusEmailSent,
  scheduleReviewEmail,
} = require('../db/orders');
const { sendDriverAssignedEmail, sendInTransitEmail, sendDeliveredEmail } = require('../services/email');
const { sendDriverDispatchedSms, sendDriverEnRouteSms, sendDeliveredSms } = require('../services/sms');

// Auth middleware: look up driver from email param (query/body).
async function requireDriver(req, res, next) {
  const email = req.query.email || req.body.email;
  if (!email) {
    return res.status(401).json({ error: 'Driver email is required' });
  }
  const driver = await getDriverByEmail(email);
  if (!driver) {
    return res.status(401).json({ error: 'Driver not found or not approved. Complete the signup process at /drive.' });
  }
  req.driver = driver;
  next();
}

router.use(requireDriver);

// GET /api/driver/jobs?email=...
// Releases expired holds opportunistically, then returns available jobs sorted by payout desc.
router.get('/jobs', async (req, res) => {
  try {
    await releaseExpiredClaims();
    const jobs = await getAvailableJobs();
    res.json({ jobs });
  } catch (err) {
    console.error('[/api/driver/jobs]', err);
    res.status(500).json({ error: 'Failed to fetch available jobs' });
  }
});

// POST /api/driver/jobs/:id/claim — soft-claim (60s hold)
router.post('/jobs/:id/claim', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' });

    const order = await claimJob(orderId, req.driver.id);
    if (!order) {
      return res.status(409).json({ error: 'Job already claimed or no longer available.' });
    }
    // Return the hold expiry so the client can show a countdown
    res.json({ success: true, claim_hold_expires_at: order.claim_hold_expires_at });
  } catch (err) {
    console.error('[/api/driver/jobs/:id/claim]', err);
    res.status(500).json({ error: 'Failed to claim job' });
  }
});

// POST /api/driver/jobs/:id/confirm — confirm hold → permanent assignment
router.post('/jobs/:id/confirm', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' });

    const d = req.driver;
    const order = await confirmClaim(orderId, d.id, d.name, d.phone);
    if (!order) {
      return res.status(409).json({ error: 'Hold expired or already taken. Tap Claim again.' });
    }

    // Fire driver-assigned email + customer SMS (idempotent)
    markStatusEmailSent(order.id, 'driver_assigned').then(first => {
      if (first) sendDriverAssignedEmail(order).catch(err => {
        console.error('[email] driver-assigned', orderId, err);
      });
    }).catch(() => {});
    sendDriverDispatchedSms(order).catch(err => {
      console.error('[sms] dispatch', orderId, err);
    });

    res.json({ success: true, order: { id: order.id, status: order.status } });
  } catch (err) {
    console.error('[/api/driver/jobs/:id/confirm]', err);
    res.status(500).json({ error: 'Failed to confirm job' });
  }
});

// POST /api/driver/jobs/:id/decline
router.post('/jobs/:id/decline', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' });
    await declineJob(orderId, req.driver.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[/api/driver/jobs/:id/decline]', err);
    res.status(500).json({ error: 'Failed to decline job' });
  }
});

// GET /api/driver/my-jobs?email=...
router.get('/my-jobs', async (req, res) => {
  try {
    const jobs = await getMyJobs(req.driver.id);
    res.json({ jobs });
  } catch (err) {
    console.error('[/api/driver/my-jobs]', err);
    res.status(500).json({ error: 'Failed to fetch your jobs' });
  }
});

// POST /api/driver/jobs/:id/start — driver leaves for pickup (en-route)
router.post('/jobs/:id/start', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' });
    const order = await markJobStarted(orderId);
    if (!order) return res.status(404).json({ error: 'Job not found or not yet assigned.' });

    markStatusEmailSent(order.id, 'en_route').then(first => {
      if (first) sendInTransitEmail(order).catch(err => {
        console.error('[email] en-route', orderId, err);
      });
    }).catch(() => {});
    sendDriverEnRouteSms(order).catch(err => {
      console.error('[sms] en-route', orderId, err);
    });

    res.json({ success: true, order: { id: order.id, status: order.status, driver_status: order.driver_status } });
  } catch (err) {
    console.error('[/api/driver/jobs/:id/start]', err);
    res.status(500).json({ error: 'Failed to start job' });
  }
});

// POST /api/driver/jobs/:id/arrived — driver at pickup location
router.post('/jobs/:id/arrived', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' });
    const order = await markJobArrived(orderId, req.driver.id);
    if (!order) return res.status(404).json({ error: 'Job not found or not in expected state.' });
    res.json({ success: true, order: { id: order.id, status: order.status, driver_status: order.driver_status } });
  } catch (err) {
    console.error('[/api/driver/jobs/:id/arrived]', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// POST /api/driver/jobs/:id/loaded — item loaded onto truck
router.post('/jobs/:id/loaded', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' });
    const order = await markJobLoaded(orderId, req.driver.id);
    if (!order) return res.status(404).json({ error: 'Job not found or not in expected state.' });
    res.json({ success: true, order: { id: order.id, status: order.status, driver_status: order.driver_status } });
  } catch (err) {
    console.error('[/api/driver/jobs/:id/loaded]', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// POST /api/driver/jobs/:id/deliver — mark delivered, fire email + SMS + schedule review
router.post('/jobs/:id/deliver', async (req, res) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    if (isNaN(orderId)) return res.status(400).json({ error: 'Invalid order ID' });
    const order = await markJobDelivered(orderId, req.driver.id);
    if (!order) return res.status(404).json({ error: 'Job not found or not in progress.' });

    // Fire delivered email + SMS (idempotent)
    markStatusEmailSent(order.id, 'delivered').then(first => {
      if (first) {
        const { sendDeliveredEmail } = require('../services/email');
        sendDeliveredEmail(order).catch(err => {
          console.error('[email] delivered', orderId, err);
        });
      }
    }).catch(() => {});
    sendDeliveredSms(order).catch(err => {
      console.error('[sms] delivered', orderId, err);
    });
    scheduleReviewEmail(order.id).catch(() => {});

    res.json({ success: true, order: { id: order.id, status: order.status } });
  } catch (err) {
    console.error('[/api/driver/jobs/:id/deliver]', err);
    res.status(500).json({ error: 'Failed to deliver job' });
  }
});

module.exports = router;
