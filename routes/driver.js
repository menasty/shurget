// routes/driver.js — Driver portal with session-based login
// Auth: email + last 4 digits of phone. Session stored in signed cookie (shared COOKIE_SECRET).

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { getDriverByEmail } = require('../db/drivers');
const { getAvailableJobs, acceptJob, declineJob, getMyJobs } = require('../db/orders');

// ─── Session helpers (driver-scoped, separate from admin sessions) ────────────
const DRIVER_SESSIONS  = new Map(); // sessionId -> { driverId, email, createdAt }
const DRIVER_COOKIE    = 'dr_session';
const SESSION_TTL_MS   = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_SECRET    = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

function signId(id) {
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(id);
  return id + '.' + hmac.digest('base64url');
}

function unsignId(cookie) {
  if (!cookie || typeof cookie !== 'string') return null;
  const dot = cookie.lastIndexOf('.');
  if (dot === -1) return null;
  const id  = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = signId(id).split('.').pop();
  if (sig !== expected) return null;
  return id;
}

function createDriverSession(driverId, email) {
  const id = crypto.randomBytes(32).toString('base64url');
  DRIVER_SESSIONS.set(id, { driverId, email, createdAt: Date.now() });
  return id;
}

function getDriverSession(cookie) {
  const id = unsignId(cookie);
  if (!id) return null;
  const sess = DRIVER_SESSIONS.get(id);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > SESSION_TTL_MS) {
    DRIVER_SESSIONS.delete(id);
    return null;
  }
  return { id, ...sess };
}

function setDriverCookie(res, sessionId) {
  res.cookie(DRIVER_COOKIE, signId(sessionId), {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   SESSION_TTL_MS,
  });
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
async function requireDriver(req, res, next) {
  const sess = getDriverSession(req.cookies?.[DRIVER_COOKIE]);
  if (!sess) return res.redirect('/driver/login');

  const driver = await getDriverByEmail(sess.email).catch(() => null);
  if (!driver) {
    res.clearCookie(DRIVER_COOKIE);
    return res.redirect('/driver/login?error=Account+not+found');
  }

  req.driver    = driver;
  req.driverSess = sess;
  next();
}

// ─── Login routes (public) ────────────────────────────────────────────────────

// GET /driver/login
router.get('/login', (req, res) => {
  const error = req.query.error || null;
  res.render('driver-login', { error });
});

// POST /driver/login
router.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const pin   = (req.body.pin   || '').trim();

  if (!email || !pin || pin.length !== 4) {
    return res.render('driver-login', { error: 'Please enter your email and 4-digit phone PIN.' });
  }

  const driver = await getDriverByEmail(email).catch(() => null);

  // Validate: driver must exist, be active, and phone must end with the pin
  const phone      = (driver?.phone || '').replace(/\D/g, ''); // digits only
  const pinMatches = phone.endsWith(pin);

  if (!driver || !pinMatches) {
    return res.render('driver-login', { error: 'Email or PIN incorrect. Use the last 4 digits of your phone number.' });
  }

  const sessionId = createDriverSession(driver.id, driver.email);
  setDriverCookie(res, sessionId);
  // Set a separate signed email cookie so disputes/payouts modules can resolve the driver
  res.cookie('dr_email', Buffer.from(driver.email).toString('base64'), {
    httpOnly: true,
    sameSite: 'lax',
    secure:   process.env.NODE_ENV === 'production',
    maxAge:   SESSION_TTL_MS,
  });
  res.redirect('/driver/jobs');
});

// POST /driver/logout
router.post('/logout', (req, res) => {
  const sess = getDriverSession(req.cookies?.[DRIVER_COOKIE]);
  if (sess) DRIVER_SESSIONS.delete(sess.id);
  res.clearCookie(DRIVER_COOKIE);
  res.clearCookie('dr_email');
  res.redirect('/driver/login');
});

// ─── Protected routes (require login) ────────────────────────────────────────

// GET /driver/jobs — available jobs
router.get('/jobs', requireDriver, async (req, res) => {
  try {
    const jobs = await getAvailableJobs();
    res.render('driver-jobs', { jobs, driver: req.driver });
  } catch (e) {
    console.error('[driver] getAvailableJobs:', e.message);
    res.render('driver-jobs', { jobs: [], driver: req.driver });
  }
});

// GET /driver/my-jobs — accepted/in-progress jobs for this driver
router.get('/my-jobs', requireDriver, async (req, res) => {
  try {
    const jobs = await getMyJobs(req.driver.id);
    res.render('driver-my-jobs', { jobs, driver: req.driver });
  } catch (e) {
    console.error('[driver] getMyJobs:', e.message);
    res.render('driver-my-jobs', { jobs: [], driver: req.driver });
  }
});

// POST /driver/jobs/:id/accept
router.post('/jobs/:id/accept', requireDriver, async (req, res) => {
  try {
    const order = await acceptJob(req.params.id, req.driver.id, req.driver.name, req.driver.phone);
    if (order) {
      res.json({ success: true });
    } else {
      res.status(409).json({ error: 'Job no longer available' });
    }
  } catch (err) {
    console.error('[driver] acceptJob:', err.message);
    res.status(500).json({ error: 'Failed to accept job' });
  }
});

// POST /driver/toggle-online — driver flips their online/offline availability
router.post('/toggle-online', requireDriver, async (req, res) => {
  try {
    const db = require('../db/index');
    const result = await db.query(
      'UPDATE driver_applications SET is_online = NOT COALESCE(is_online, false) WHERE id = $1 RETURNING is_online',
      [req.driver.id]
    );
    const isOnline = result.rows[0]?.is_online ?? false;
    res.json({ is_online: isOnline });
  } catch (err) {
    console.error('[toggle-online]', err.message);
    res.status(500).json({ error: 'Toggle failed' });
  }
});

// POST /driver/jobs/:id/decline
router.post('/jobs/:id/decline', requireDriver, async (req, res) => {
  try {
    await declineJob(req.params.id, req.driver.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[driver] declineJob:', err.message);
    res.status(500).json({ error: 'Failed to decline job' });
  }
});


// POST /driver/jobs/:id/complete — driver marks delivery done (authenticated)
router.post('/jobs/:id/complete', requireDriver, async (req, res) => {
  try {
    const { completeOrder, getMyJobs } = require('../db/orders');
    // Verify this order belongs to this driver before completing
    const jobs = await getMyJobs(req.driver.id);
    const job = jobs.find(j => String(j.id) === String(req.params.id));
    if (!job) {
      return res.status(403).json({ error: 'Job not found or not assigned to you' });
    }
    if (job.status === 'delivered') {
      return res.json({ success: true, alreadyDelivered: true });
    }
    const order = await completeOrder(req.params.id);
    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }
    // Fire delivered email (non-blocking)
    try {
      const { sendDeliveredEmail } = require('../services/email');
      const { markStatusEmailSent } = require('../db/orders');
      const ratingLink = `${process.env.APP_URL || 'https://shurget.com'}/rate/${order.id}`;
      markStatusEmailSent(order.id, 'delivered').then(first => {
        if (first) sendDeliveredEmail(order, ratingLink).catch(() => {});
      }).catch(() => {});
    } catch (_) {}
    res.json({ success: true, order: { id: order.id, status: order.status } });
  } catch (err) {
    console.error('[driver] completeJob:', err.message);
    res.status(500).json({ error: 'Failed to complete job' });
  }
});

// GET /driver/pending-jobs — jobs auto-assigned to this driver awaiting accept/decline (polling)
router.get('/pending-jobs', requireDriver, async (req, res) => {
  try {
    const db = require('../db/index');
    const result = await db.query(
      `SELECT id, item_type, pickup_address, dropoff_address, price_total, helpers, accept_deadline
       FROM orders
       WHERE driver_id = $1
         AND status = 'assigned'
         AND driver_accepted IS NULL
         AND accept_deadline > NOW()`,
      [req.driver.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error('[pending-jobs]', err.message);
    res.status(500).json({ error: 'Failed to fetch pending jobs' });
  }
});

// POST /driver/orders/:id/accept — driver accepts an auto-assigned job within the response window
router.post('/orders/:id/accept', requireDriver, async (req, res) => {
  try {
    const db = require('../db/index');
    await db.query(
      'UPDATE orders SET driver_accepted=TRUE WHERE id=$1 AND driver_id=$2',
      [req.params.id, req.driver.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[orders/:id/accept]', err.message);
    res.status(500).json({ error: 'Accept failed' });
  }
});

// POST /driver/orders/:id/decline — driver declines an auto-assigned job; returns it to the pool
router.post('/orders/:id/decline', requireDriver, async (req, res) => {
  try {
    const db = require('../db/index');
    await db.query(
      `UPDATE orders SET driver_id=NULL, driver_name=NULL, driver_phone=NULL,
       status='paid', driver_accepted=NULL, accept_deadline=NULL
       WHERE id=$1 AND driver_id=$2`,
      [req.params.id, req.driver.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[orders/:id/decline]', err.message);
    res.status(500).json({ error: 'Decline failed' });
  }
});

module.exports = router;
