const express = require('express');
const path = require('path');
const { buildLandingContext } = require('./lib/landing-context');
const {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getSession,
  signSession,
  unsign,
  validateCredentials,
  requireAdmin,
} = require('./middleware/session');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

// Attach signed-cookie session to every request
app.use((req, _res, next) => {
  const raw = (req.headers['cookie'] || '').split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) acc[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1));
    return acc;
  }, {});
  const signed = raw[SESSION_COOKIE];
  if (signed) {
    const sessionId = unsign(signed);
    if (sessionId) {
      const sess = getSession(sessionId);
      if (sess) req.session = { sessionId, adminEmail: sess.adminEmail };
    }
  }
  if (!req.session) req.session = null;
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Inject GA4 measurement ID into every EJS view via res.locals
app.use((_req, res, next) => {
  res.locals.ga4Id = process.env.GA4_MEASUREMENT_ID || '';
  next();
});

// UTM first-touch cookie — set once on landing when utm_source is present, never overwritten.
// Cookie is HttpOnly so it survives across pages but is only read server-side or forwarded by JS.
// We store it in a plain JSON cookie (not signed; not sensitive — it's just ad attribution).
app.use((req, res, next) => {
  const src = req.query.utm_source;
  if (!src) return next();
  // Read raw cookies manually (same approach as session middleware above)
  const raw = (req.headers['cookie'] || '').split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) acc[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    return acc;
  }, {});
  // First-touch: only set if no existing utm_first cookie
  if (!raw['utm_first']) {
    const utm = JSON.stringify({
      s: String(src).slice(0, 80),
      m: String(req.query.utm_medium   || '').slice(0, 80),
      c: String(req.query.utm_campaign || '').slice(0, 80),
    });
    res.cookie('utm_first', encodeURIComponent(utm), {
      httpOnly: false, // must be readable by booking.js to forward to API
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    });
  }
  next();
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy' });
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.get('/', (_req, res) => {
  res.render('layout', buildLandingContext());
});

// Booking flow
app.get('/book', (_req, res) => {
  res.render('booking');
});

app.get('/pricing', (_req, res) => {
  res.render('layout', buildLandingContext());
});

// Help & FAQ
app.get('/help', (_req, res) => {
  res.render('help');
});

// Legal pages
app.get('/terms', (_req, res) => {
  res.render('terms');
});

app.get('/privacy', (_req, res) => {
  res.render('privacy');
});

app.get('/cookies', (_req, res) => {
  res.render('cookies');
});

// Driver availability waitlist (shown when no drivers match)
app.get('/notify', (_req, res) => {
  res.render('notify');
});

// Contact page + quote request API
app.use('/contact',       require('./routes/contact'));
app.use('/api/contact',   require('./routes/contact'));

// Partners landing page + pilot lead API
app.use('/partners',      require('./routes/partners'));
app.use('/api/partners',  require('./routes/partners'));

// Embeddable widget — iframe quote modal + price calculation API
app.use('/embed',         require('./routes/embed'));
app.use('/api/embed',     require('./routes/embed'));

app.get('/confirmation/:id', async (req, res) => {
  const { getOrderById } = require('./db/orders');
  const order = await getOrderById(req.params.id);
  if (!order) return res.status(404).render('404');
  res.render('confirmation', { order });
});

// Order tracking — standalone /track/:id page + API for polling
app.use('/track', require('./routes/track'));

// Stripe webhook — must be mounted before express.json() so body stays raw
app.use('/api/webhooks', require('./routes/webhooks'));
// Inbound SMS webhook (Twilio opt-out handler)
app.use('/api/sms',      require('./routes/sms'));

// API routes
app.use('/api/booking',  require('./routes/booking'));
app.use('/api/orders',   require('./routes/orders'));
app.use('/api/drive',    require('./routes/drive'));
app.use('/api/driver',   require('./routes/driver'));
app.use('/api/referral', require('./routes/referral'));
app.use('/drive',        require('./routes/drive'));

// Driver payout onboarding + earnings (/driver/payouts, /driver/earnings, /api/driver/payouts/*)
app.use('/', require('./routes/payouts'));

app.get('/dashboard', async (req, res) => {
  const { getOrdersByEmail } = require('./db/orders');
  const email = req.query.email;
  const orders = email ? await getOrdersByEmail(email) : [];
  res.render('dashboard', { email: email || '', orders });
});

app.get('/driver/jobs', async (req, res) => {
  const { getDriverByEmail } = require('./db/drivers');
  const email = req.query.email;
  const driver = email ? await getDriverByEmail(email) : null;
  res.render('driver-jobs', { driver });
});

// Driver rating page + API
app.use('/rate',        require('./routes/reviews'));
app.use('/api/reviews', require('./routes/reviews'));

// Driver self-service: dispute form + dispute list + dispute API
app.use('/driver',      require('./routes/disputes'));
app.use('/api/driver',  require('./routes/driver'));

// Austin local-SEO landing pages
app.use('/', require('./routes/seo'));

// Admin auth routes — mounted BEFORE the requireAdmin middleware so unauth'd users can reach them
app.get('/admin/login', (req, res) => {
  if (req.session && req.session.adminEmail) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminUser || !adminPass) {
    return res.status(500).render('admin-login', {
      error: 'Admin credentials not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD in environment.',
    });
  }

  if (username === adminUser && password === adminPass) {
    const sessionId = createSession(adminUser);
    const signed = signSession(sessionId);
    res.cookie(SESSION_COOKIE, signed, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 8 * 60 * 60 * 1000,
    });
    return res.redirect('/admin');
  }

  res.render('admin-login', { error: 'Invalid credentials. Try again.' });
});

app.get('/admin/logout', (req, res) => {
  if (req.session && req.session.sessionId) destroySession(req.session.sessionId);
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/admin/login');
});

// Admin routes — protected by requireAdmin middleware
app.use('/admin', require('./middleware/session').requireAdmin, require('./routes/admin'));

// Global error handler — ensures JSON responses for API routes, even on body-size errors
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Upload too large. Please use smaller document files.' });
  }
  if (err && err.message && err.message.includes('request entity too large')) {
    return res.status(413).json({ error: 'Upload too large. Please use smaller document files.' });
  }
  // If headers already sent, delegate to default
  if (res.headersSent) return _next(err);
  console.error('[unhandled]', err);
  // JSON for API routes, HTML pages for page routes
  if (_req.path.startsWith('/api/') || (_req.accepts('json') && !_req.accepts('html'))) {
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  } else if (err.status === 404) {
    res.status(404).render('404');
  } else {
    res.status(err.status || 500).render('error', { message: err.message || 'Something went wrong. Please try again.' });
  }
});

// 404 handler — runs after all routes, catches unmatched URLs
app.use((_req, res) => {
  res.status(404).render('404');
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
