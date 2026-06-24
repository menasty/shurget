// routes/admin.js — Admin section: dashboard, driver management, dispatch, ratings
// Auth: protected by session middleware in server.js (requireAdmin). No ?admin= query params.
// Owns: admin-only views + actions (approve drivers, dispatch orders, mark delivered, cancel).
// Does NOT own: Stripe Checkout, customer-facing booking, driver onboarding.
// Lifecycle helpers (triggerPayout, checkAndPayReferralBounty, addPartnerCommission) live in services/admin-helpers.js.

const express = require('express');
const router = express.Router();
const {
  getDriverApplications, activateDriver, getActiveDrivers,
  updateBackgroundCheckStatus,
} = require('../db/drivers');
const {
  getPendingDispatches, getActiveDispatches, getRecentCompleted,
  assignDriverToOrder, markDelivered, cancelOrder, markJobStarted,
  getMetrics, getOrdersByStatus, getOrdersBySizeTier,
  getDailyOrderVolume, getTopRoutes, getAllOrders, countOrders,
  scheduleReviewEmail,
  getBookingsBySource, getDriverSignupsBySource, getReferralFunnel,
} = require('../db/orders');
const { sendDriverAssignedSms, sendInTransitSms, sendDeliveredSms, sendAdminNewDriverSignupSms } = require('../services/sms');
const { sendDriverAssignedEmail, sendInTransitEmail, sendDeliveredEmail, sendCancelledEmail } = require('../services/email');
const { markStatusEmailSent } = require('../db/orders');
const { triggerPayout, checkAndPayReferralBounty, addPartnerCommission } = require('../services/admin-helpers');
const { countEmailRatings, countReviewEmailsSent, getDisputes, resolveDispute } = require('../db/ratings');

// GET /admin — admin dashboard landing page
router.get('/', (req, res) => {
  res.render('admin-index', { adminEmail: req.adminEmail });
});

// GET /admin/drivers — list all driver applications
router.get('/drivers', async (req, res, next) => {
  try {
    const drivers = await getDriverApplications();
    res.render('admin-drivers', { drivers, adminEmail: req.adminEmail });
  } catch (err) { next(err); }
});

// POST /admin/drivers/:id/activate — activate a pending driver
router.post('/drivers/:id/activate', async (req, res, next) => {
  try {
    const driver = await activateDriver(req.params.id);
    if (driver) {
      sendAdminNewDriverSignupSms(driver.name, driver.email).catch(err => {
        console.error('[sms] Failed to send new driver signup SMS:', err.message);
      });
    }
    res.redirect('/admin/drivers');
  } catch (err) { next(err); }
});

// POST /admin/drivers/:id/background-check — update background check status
router.post('/drivers/:id/background-check', async (req, res) => {
  const { status } = req.body;
  if (!['cleared', 'pending', 'failed'].includes(status)) {
    return res.redirect('/admin/drivers?error=invalid-bg-status');
  }
  await updateBackgroundCheckStatus(req.params.id, status);
  res.redirect('/admin/drivers?bg_updated=1');
});

// GET /admin/ratings — stub page
router.get('/ratings', (req, res) => {
  res.render('admin-ratings', { adminEmail: req.adminEmail });
});

// GET /admin/dispute — admin dispute review panel
router.get('/disputes', async (req, res, next) => {
  try {
    const disputes = await getDisputes();
    res.render('admin-disputes', { disputes, adminEmail: req.adminEmail });
  } catch (err) { next(err); }
});

// POST /admin/disputes/:id/resolve — override or dismiss a dispute
router.post('/disputes/:id/resolve', async (req, res) => {
  const { status, adminNotes } = req.body;
  if (!['overridden', 'dismissed'].includes(status)) {
    return res.redirect('/admin/disputes?error=invalid');
  }
  await resolveDispute(req.params.id, { status, adminNotes });
  res.redirect('/admin/disputes?resolved=1');
});

// GET /admin/dispatch — dispatch management UI
router.get('/dispatch', async (req, res, next) => {
  try {
    const [pending, active, recent, drivers] = await Promise.all([
      getPendingDispatches(), getActiveDispatches(), getRecentCompleted(10), getActiveDrivers(),
    ]);
    res.render('admin-dispatch', { pending, active, recent, drivers, adminEmail: req.adminEmail });
  } catch (err) { next(err); }
});

// POST /admin/dispatch/:id/assign — assign a driver to an order
router.post('/dispatch/:id/assign', async (req, res) => {
  const { driverId, driverName, driverPhone } = req.body;
  if (!driverId || !driverName) return res.redirect('/admin/dispatch?error=missing');
  const order = await assignDriverToOrder(req.params.id, parseInt(driverId), driverName, driverPhone || '', 15);
  if (order) {
    sendDriverAssignedSms(order).catch(err => { console.error('[sms] Driver-assigned SMS failed:', err.message); });
    // Send driver-assigned lifecycle email (idempotent)
    markStatusEmailSent(order.id, 'driver_assigned').then(first => {
      if (first) sendDriverAssignedEmail(order).catch(err => { console.error('[email] Driver-assigned email failed:', err.message); });
    }).catch(() => {});
  }
  res.redirect('/admin/dispatch?assigned=1');
});

// POST /admin/dispatch/:id/deliver — mark delivered + fire all post-delivery side-effects
router.post('/dispatch/:id/deliver', async (req, res) => {
  const order = await markDelivered(req.params.id);
  if (order) {
    triggerPayout(order).catch(() => {});
    checkAndPayReferralBounty(order).catch(() => {});
    addPartnerCommission(order).catch(err => { console.error('[partner-commission] Failed:', err.message); });
    scheduleReviewEmail(order.id).catch(err => { console.error('[review] Failed:', err.message); });
    sendDeliveredSms(order).catch(err => { console.error('[sms] Delivered SMS failed:', err.message); });
    // Send delivered lifecycle email (idempotent)
    markStatusEmailSent(order.id, 'delivered').then(first => {
      if (first) {
        const ratingLink = `https://shurget-5.polsia.app/rate/${order.id}`;
        sendDeliveredEmail(order, ratingLink).catch(err => { console.error('[email] Delivered email failed:', err.message); });
      }
    }).catch(() => {});
  }
  res.redirect('/admin/dispatch?delivered=1');
});

// POST /admin/dispatch/:id/start — driver en route
router.post('/dispatch/:id/start', async (req, res) => {
  const order = await markJobStarted(req.params.id);
  if (order) {
    sendInTransitSms(order).catch(err => { console.error('[sms] In-transit SMS failed:', err.message); });
    // Send en-route lifecycle email (idempotent)
    markStatusEmailSent(order.id, 'en_route').then(first => {
      if (first) sendInTransitEmail(order).catch(err => { console.error('[email] In-transit email failed:', err.message); });
    }).catch(() => {});
  }
  res.redirect('/admin/dispatch?started=1');
});

// POST /admin/dispatch/:id/cancel — cancel an order
router.post('/dispatch/:id/cancel', async (req, res) => {
  const order = await cancelOrder(req.params.id);
  if (order) {
    // Send cancelled lifecycle email (idempotent)
    markStatusEmailSent(order.id, 'cancelled').then(first => {
      if (first) sendCancelledEmail(order).catch(err => { console.error('[email] Cancelled email failed:', err.message); });
    }).catch(() => {});
  }
  res.redirect('/admin/dispatch?cancelled=1');
});

// GET /admin/metrics — order metrics dashboard
router.get('/metrics', async (req, res, next) => {
  try {
    const [metrics, byStatus, byTier, daily, topRoutes, reviewEmailStats, ratingStats] = await Promise.all([
      getMetrics(), getOrdersByStatus(), getOrdersBySizeTier(),
      getDailyOrderVolume(), getTopRoutes(), countReviewEmailsSent(), countEmailRatings(),
    ]);
    res.render('admin-metrics', { metrics, byStatus, byTier, daily, topRoutes, reviewEmailStats, ratingStats, adminEmail: req.adminEmail });
  } catch (err) { next(err); }
});

// GET /admin/bookings — full order list
router.get('/bookings', async (req, res, next) => {
  try {
    const { status = 'all', sort = 'created_at', dir = 'desc' } = req.query;
    const [orders, total, drivers] = await Promise.all([
      getAllOrders({ status, sort, dir, limit: 50, offset: 0 }),
      countOrders(status),
      getActiveDrivers(),
    ]);
    res.render('admin-bookings', { orders, total, adminEmail: req.adminEmail, filters: { status, sort, dir }, drivers, flash: null });
  } catch (err) { next(err); }
});

// POST /admin/bookings/:id/cancel
router.post('/bookings/:id/cancel', async (req, res) => {
  await cancelOrder(req.params.id);
  res.redirect('/admin/bookings?flash=cancelled');
});

// POST /admin/bookings/:id/reassign
router.post('/bookings/:id/reassign', async (req, res) => {
  const { driverId, driverName, driverPhone } = req.body;
  if (driverId && driverName) await assignDriverToOrder(req.params.id, parseInt(driverId), driverName, driverPhone || '', 15);
  res.redirect('/admin/bookings?flash=assigned');
});

// GET /admin/attribution — UTM attribution dashboard
router.get('/attribution', async (req, res, next) => {
  try {
    const { range = '30d' } = req.query;
    const [bookings, drivers, referrals] = await Promise.all([
      getBookingsBySource(range),
      getDriverSignupsBySource(range),
      getReferralFunnel(range),
    ]);
    res.render('admin-attribution', { bookings, drivers, referrals, range, adminEmail: req.adminEmail });
  } catch (err) { next(err); }
});

// GET /admin/attribution/export.csv — CSV export
router.get('/attribution/export.csv', async (req, res, next) => {
  try {
    const { range = '30d', type = 'bookings' } = req.query;
    let rows;
    let header;
    if (type === 'drivers') {
      rows = await getDriverSignupsBySource(range);
      header = 'source,medium,campaign,signups';
      const csv = [header, ...rows.map(r =>
        [r.source, r.medium, r.campaign, r.signups].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
      )].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="driver-attribution.csv"');
      return res.send(csv);
    } else if (type === 'referrals') {
      rows = await getReferralFunnel(range);
      header = 'code,owner_email,redemptions,paid_orders,discount_paid_dollars';
      const csv = [header, ...rows.map(r =>
        [r.code, r.owner_email, r.redemptions, r.paid_orders, r.discount_paid_cents ? (r.discount_paid_cents / 100).toFixed(2) : '0.00']
          .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
      )].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="referral-funnel.csv"');
      return res.send(csv);
    } else {
      rows = await getBookingsBySource(range);
      header = 'source,medium,campaign,bookings,gross_revenue,net_fee,avg_order_value';
      const csv = [header, ...rows.map(r =>
        [r.source, r.medium, r.campaign, r.bookings, r.gross_revenue, r.net_fee, r.avg_order_value]
          .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')
      )].join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="booking-attribution.csv"');
      return res.send(csv);
    }
  } catch (err) { next(err); }
});

// GET /admin/partners — partner management
router.get('/partners', async (req, res, next) => {
  try {
    const { getAllApplications, getAllPartners } = require('../db/partners');
    const { getAllQuoteRequests } = require('../db/quote_requests');
    const [applications, partners, leadRequests] = await Promise.all([
      getAllApplications(), getAllPartners(), getAllQuoteRequests(),
    ]);
    res.render('admin-partners', { applications, partners, leadRequests });
  } catch (err) { next(err); }
});

module.exports = router;