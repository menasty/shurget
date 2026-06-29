const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');
const {
  SESSION_COOKIE,
  createSession,
  destroySession,
  unsign,
  signSession,
  validateCredentials,
  requireAdmin,
} = require('../middleware/session');
const {
  assignDriverToOrder,
  markDelivered,
  cancelOrder,
  getOrderById,
} = require('../db/orders');
const {
  sendDriverAssignedEmail,
  sendDriverNewJobAlert,
  sendDeliveredEmail,
  sendCancelledEmail,
} = require('../services/email');

const DEFAULT_ADMIN_EMAIL = 'admin@shurget.com';

function getAdminEmail(req) {
  return req.adminEmail || DEFAULT_ADMIN_EMAIL;
}

// ─── Auth ───────────────────────────────────────────────────────────────────

/** GET /admin/login — render login form */
router.get('/login', (req, res) => {
  res.render('admin-login', { error: null });
});

/** POST /admin/login — validate credentials, set signed session cookie */
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!validateCredentials(username, password)) {
    return res.status(401).render('admin-login', { error: 'Invalid username or password.' });
  }
  const sessionId = createSession(username);
  const signed = signSession(sessionId);
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=${signed}; HttpOnly; SameSite=Lax; Max-Age=28800; Path=/`);
  res.redirect('/admin');
});

/** GET|POST /admin/logout — clear session */
function doLogout(req, res) {
  const sessionId = unsign(req.cookies?.[SESSION_COOKIE]);
  if (sessionId) destroySession(sessionId);
  res.setHeader('Set-Cookie',
    `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/`);
  res.redirect('/admin/login');
}
router.get('/logout', doLogout);
router.post('/logout', doLogout);

// Everything below requires an authenticated admin.
router.use(requireAdmin);

function getSafeBookingFilters(query) {
  const allowedStatus = new Set([
    'all',
    'pending',
    'paid',
    'assigned',
    'in_progress',
    'delivered',
    'cancelled',
    'pending_payment'
  ]);
  const allowedSort = new Set(['created_at', 'price_total', 'status']);

  const status = allowedStatus.has(query.status) ? query.status : 'all';
  const sort = allowedSort.has(query.sort) ? query.sort : 'created_at';
  const dir = query.dir === 'asc' ? 'asc' : 'desc';

  return { status, sort, dir };
}

const defaultMetricsViewModel = {
  metrics: {
    totals: {
      total_orders: 0,
      completed: 0,
      cancelled: 0,
      avg_order_value: 0,
      total_revenue: 0
    },
    week: { cnt: 0, revenue: 0 },
    month: { cnt: 0, revenue: 0 }
  },
  byStatus: [],
  byTier: [],
  daily: [],
  topRoutes: [],
  reviewEmailStats: { cnt: 0 },
  ratingStats: { cnt: 0, avg_rating: 0 }
};

router.get('/', (req, res) => {
  res.render('admin-index', { adminEmail: getAdminEmail(req) });
});

// Drivers
router.get('/drivers', async (req, res) => {
  const adminEmail = getAdminEmail(req);
  try {
    const result = await pool.query('SELECT * FROM driver_applications ORDER BY created_at DESC');
    res.render('admin-drivers', { 
      drivers: result.rows || [],
      adminEmail
    });
  } catch (e) {
    res.render('admin-drivers', { drivers: [], adminEmail });
  }
});

// Bookings
router.get('/bookings', async (req, res) => {
  const adminEmail = getAdminEmail(req);
  const filters = getSafeBookingFilters(req.query || {});
  const flash = req.query.flash || null;

  const where = [];
  const params = [];
  if (filters.status !== 'all') {
    params.push(filters.status);
    where.push(`status = $${params.length}`);
  }

  const query = `
    SELECT *
    FROM orders
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${filters.sort} ${filters.dir.toUpperCase()}
  `;

  try {
    const [ordersResult, driversResult] = await Promise.all([
      pool.query(query, params),
      pool.query('SELECT id, name, phone, city, vehicle_type FROM driver_applications WHERE status = $1 ORDER BY name ASC', ['active'])
    ]);

    const orders = ordersResult.rows || [];
    const drivers = driversResult.rows || [];

    res.render('admin-bookings', { 
      orders,
      drivers,
      filters,
      total: orders.length,
      flash,
      adminEmail
    });
  } catch (e) {
    res.render('admin-bookings', {
      orders: [],
      drivers: [],
      filters,
      total: 0,
      flash,
      adminEmail
    });
  }
});

// Dispatch
router.get('/dispatch', async (req, res) => {
  const adminEmail = getAdminEmail(req);
  try {
    const [driversResult, pendingResult, activeResult, recentResult] = await Promise.all([
      pool.query('SELECT * FROM driver_applications WHERE status = $1 ORDER BY created_at DESC', ['active']),
      pool.query("SELECT * FROM orders WHERE status IN ('pending', 'paid', 'pending_payment') ORDER BY created_at DESC"),
      pool.query("SELECT * FROM orders WHERE status IN ('assigned', 'in_progress') ORDER BY created_at DESC"),
      pool.query("SELECT * FROM orders WHERE status IN ('delivered', 'cancelled') ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 20")
    ]);

    res.render('admin-dispatch', { 
      drivers: driversResult.rows || [],
      pending: pendingResult.rows || [],
      active: activeResult.rows || [],
      recent: recentResult.rows || [],
      assigned: req.query.assigned === '1',
      delivered: req.query.delivered === '1',
      cancelled: req.query.cancelled === '1',
      error: req.query.error || null,
      adminEmail
    });
  } catch (e) {
    res.render('admin-dispatch', {
      drivers: [],
      pending: [],
      active: [],
      recent: [],
      assigned: false,
      delivered: false,
      cancelled: false,
      error: null,
      adminEmail
    });
  }
});

// Metrics
router.get('/metrics', async (req, res) => {
  const adminEmail = getAdminEmail(req);

  try {
    const [totalsResult, weekResult, monthResult, byStatusResult, byTierResult, dailyResult, topRoutesResult, reviewEmailResult, ratingResult] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*)::int AS total_orders,
          COUNT(*) FILTER (WHERE status = 'delivered')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
          COALESCE(AVG(price_total), 0)::float AS avg_order_value,
          COALESCE(SUM(price_fee), 0)::float AS total_revenue
        FROM orders
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS cnt,
          COALESCE(SUM(price_fee), 0)::float AS revenue
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '7 days'
      `),
      pool.query(`
        SELECT
          COUNT(*)::int AS cnt,
          COALESCE(SUM(price_fee), 0)::float AS revenue
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '30 days'
      `),
      pool.query(`
        SELECT status, COUNT(*)::int AS cnt
        FROM orders
        GROUP BY status
      `),
      pool.query(`
        SELECT
          CASE
            WHEN COALESCE(price_base, 0) < 50 THEN 'small'
            WHEN COALESCE(price_base, 0) < 70 THEN 'medium'
            ELSE 'large'
          END AS tier,
          COUNT(*)::int AS cnt
        FROM orders
        GROUP BY tier
      `),
      pool.query(`
        SELECT DATE(created_at) AS date, COUNT(*)::int AS orders
        FROM orders
        WHERE created_at >= NOW() - INTERVAL '30 days'
        GROUP BY DATE(created_at)
        ORDER BY DATE(created_at) ASC
      `),
      pool.query(`
        SELECT
          SPLIT_PART(COALESCE(pickup_address, ''), ',', 2) AS pickup_city,
          SPLIT_PART(COALESCE(dropoff_address, ''), ',', 2) AS dropoff_city,
          COUNT(*)::int AS cnt,
          COALESCE(SUM(price_fee), 0)::float AS total_revenue
        FROM orders
        GROUP BY pickup_city, dropoff_city
        ORDER BY cnt DESC
        LIMIT 5
      `),
      pool.query(`
        SELECT COUNT(*)::int AS cnt
        FROM orders
        WHERE review_email_sent_at IS NOT NULL
      `),
      pool.query(`
        SELECT COUNT(*)::int AS cnt, COALESCE(AVG(rating), 0)::float AS avg_rating
        FROM driver_ratings
        WHERE source = 'email'
      `)
    ]);

    const viewModel = {
      metrics: {
        totals: totalsResult.rows[0] || defaultMetricsViewModel.metrics.totals,
        week: weekResult.rows[0] || defaultMetricsViewModel.metrics.week,
        month: monthResult.rows[0] || defaultMetricsViewModel.metrics.month
      },
      byStatus: byStatusResult.rows || [],
      byTier: byTierResult.rows || [],
      daily: dailyResult.rows || [],
      topRoutes: (topRoutesResult.rows || []).map((route) => ({
        ...route,
        pickup_city: (route.pickup_city || '').trim() || 'Unknown',
        dropoff_city: (route.dropoff_city || '').trim() || 'Unknown'
      })),
      reviewEmailStats: reviewEmailResult.rows[0] || defaultMetricsViewModel.reviewEmailStats,
      ratingStats: ratingResult.rows[0] || defaultMetricsViewModel.ratingStats,
      adminEmail
    };

    res.render('admin-metrics', viewModel);
  } catch (e) {
    res.render('admin-metrics', {
      ...defaultMetricsViewModel,
      adminEmail
    });
  }
});

// Ratings
router.get('/ratings', (req, res) => {
  res.render('admin-ratings', { adminEmail: getAdminEmail(req) });
});

// ─── Dispatch actions ─────────────────────────────────────────────────────────

async function lookupDriver(driverId) {
  const { rows } = await pool.query(
    'SELECT id, name, phone FROM driver_applications WHERE id = $1',
    [driverId]
  );
  return rows[0] || null;
}

/** POST /admin/dispatch/:id/assign — assign a driver to a paid order */
router.post('/dispatch/:id/assign', async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const driverId = parseInt(req.body.driverId, 10);
  if (!orderId || !driverId) {
    return res.redirect('/admin/dispatch?error=Invalid+order+or+driver');
  }
  try {
    const driver = await lookupDriver(driverId);
    if (!driver) return res.redirect('/admin/dispatch?error=Driver+not+found');
    await assignDriverToOrder(orderId, driver.id, driver.name, driver.phone);
    // Lifecycle emails — non-blocking, never crash dispatch on email failure
    getOrderById(orderId).then(order => {
      if (!order) return;
      if (order.customer_email) sendDriverAssignedEmail(order).catch(e => console.error('[email] sendDriverAssignedEmail:', e.message));
      if (driver.email) {
        const appUrl = process.env.APP_URL || 'https://shurgetapp.com';
        sendDriverNewJobAlert({
          driverEmail:    driver.email,
          driverName:     driver.name,
          orderId:        order.id,
          itemType:       order.item_type,
          pickupAddress:  order.pickup_address,
          dropoffAddress: order.dropoff_address,
          priceTotal:     order.price_total,
          claimUrl:       `${appUrl}/driver/jobs/${order.id}`,
        }).catch(e => console.error('[email] sendDriverNewJobAlert:', e.message));
      }
    }).catch(e => console.error('[email] getOrderById (assign):', e.message));
    res.redirect('/admin/dispatch?assigned=1');
  } catch (e) {
    console.error('[admin] assign failed:', e.message);
    res.redirect('/admin/dispatch?error=Assign+failed');
  }
});

/** POST /admin/dispatch/:id/deliver — mark an order delivered */
router.post('/dispatch/:id/deliver', async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  try {
    if (orderId) await markDelivered(orderId);
    // Send delivered email — non-blocking
    if (orderId) {
      getOrderById(orderId).then(order => {
        if (!order || !order.customer_email) return;
        const appUrl = process.env.APP_URL || 'https://shurgetapp.com';
        const ratingLink = `${appUrl}/rate/${order.id}`;
        sendDeliveredEmail(order, ratingLink).catch(e => console.error('[email] sendDeliveredEmail:', e.message));
      }).catch(e => console.error('[email] getOrderById (deliver):', e.message));
    }
    res.redirect('/admin/dispatch?delivered=1');
  } catch (e) {
    console.error('[admin] deliver failed:', e.message);
    res.redirect('/admin/dispatch?error=Deliver+failed');
  }
});

/** POST /admin/dispatch/:id/cancel — cancel an order */
router.post('/dispatch/:id/cancel', async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  try {
    if (orderId) {
      const order = await getOrderById(orderId);
      await cancelOrder(orderId);
      if (order && order.customer_email) {
        sendCancelledEmail(order).catch(e => console.error('[email] sendCancelledEmail:', e.message));
      }
    }
    res.redirect('/admin/dispatch?cancelled=1');
  } catch (e) {
    console.error('[admin] cancel failed:', e.message);
    res.redirect('/admin/dispatch?error=Cancel+failed');
  }
});

// ─── Bookings actions ─────────────────────────────────────────────────────────

/** POST /admin/bookings/:id/cancel — cancel an order from the bookings table */
router.post('/bookings/:id/cancel', async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  try {
    if (orderId) {
      const order = await getOrderById(orderId);
      await cancelOrder(orderId);
      if (order && order.customer_email) {
        sendCancelledEmail(order).catch(e => console.error('[email] sendCancelledEmail (bookings):', e.message));
      }
    }
    res.redirect('/admin/bookings?flash=Order+cancelled');
  } catch (e) {
    console.error('[admin] booking cancel failed:', e.message);
    res.redirect('/admin/bookings?flash=Cancel+failed');
  }
});

/** POST /admin/bookings/:id/reassign — reassign a driver from the bookings table */
router.post('/bookings/:id/reassign', async (req, res) => {
  const orderId = parseInt(req.params.id, 10);
  const driverId = parseInt(req.body.driverId, 10);
  if (!orderId || !driverId) {
    return res.redirect('/admin/bookings?flash=Invalid+order+or+driver');
  }
  try {
    const driver = await lookupDriver(driverId);
    if (!driver) return res.redirect('/admin/bookings?flash=Driver+not+found');
    await assignDriverToOrder(orderId, driver.id, driver.name, driver.phone);
    res.redirect('/admin/bookings?flash=Driver+reassigned');
  } catch (e) {
    console.error('[admin] reassign failed:', e.message);
    res.redirect('/admin/bookings?flash=Reassign+failed');
  }
});

// ─── Driver actions ───────────────────────────────────────────────────────────

/** POST /admin/drivers/:id/activate — move a driver into the active matching pool */
router.post('/drivers/:id/activate', async (req, res) => {
  const driverId = parseInt(req.params.id, 10);
  try {
    if (driverId) {
      await pool.query(
        "UPDATE driver_applications SET status = 'active', reviewed_at = NOW() WHERE id = $1",
        [driverId]
      );
    }
    res.redirect('/admin/drivers');
  } catch (e) {
    console.error('[admin] activate failed:', e.message);
    res.redirect('/admin/drivers');
  }
});

/** POST /admin/drivers/:id/background-check — update background check status */
router.post('/drivers/:id/background-check', async (req, res) => {
  const driverId = parseInt(req.params.id, 10);
  const allowed = new Set(['pending', 'cleared', 'failed']);
  const status = allowed.has(req.body.status) ? req.body.status : 'pending';
  try {
    if (driverId) {
      await pool.query(
        'UPDATE driver_applications SET background_check_status = $2 WHERE id = $1',
        [driverId, status]
      );
    }
    res.redirect('/admin/drivers');
  } catch (e) {
    console.error('[admin] background-check failed:', e.message);
    res.redirect('/admin/drivers');
  }
});

module.exports = router;
