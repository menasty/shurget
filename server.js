const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 3000;

// Trust Render's proxy so req.protocol / secure cookies behave correctly.
app.set('trust proxy', 1);

// ── Stripe webhooks MUST be mounted BEFORE the JSON body parser ──
// The Stripe signature check needs the raw request body (the route applies
// express.raw() itself). If express.json() ran first it would consume the
// body and signature verification would always fail.
app.use('/api/webhooks', require('./routes/webhooks'));

// Body parsers
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Minimal cookie parser (no external dependency). middleware/session.js and
// routes/partners.js read req.cookies, so this must run before any auth route.
app.use((req, _res, next) => {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx > -1) {
        const key = pair.slice(0, idx).trim();
        const val = pair.slice(idx + 1).trim();
        if (key) req.cookies[key] = decodeURIComponent(val);
      }
    });
  }
  next();
});

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── Routes ──────────────────────────────────────────────────────────────────
// Customer booking + order flow
app.use('/book', require('./routes/booking'));
app.use('/confirmation', require('./routes/confirmation'));
app.use('/track', require('./routes/track'));

// Contact / quote requests (page at /contact, API at /api/contact)
const contact = require('./routes/contact');
app.use('/contact', contact);
app.use('/api/contact', contact);

// Admin (auth handled inside the router)
app.use('/admin', require('./routes/admin'));

// Driver onboarding
app.use('/drive', require('./routes/drive'));

// Driver self-service pages MUST be mounted before routes/driver.js.
// routes/driver.js applies a global requireDriver middleware to everything
// under /driver, which would otherwise intercept these pages and 401 them.
const disputes = require('./routes/disputes');
app.use('/driver', disputes);   // /driver/dispute/new, /driver/disputes
app.use('/', disputes);          // /api/driver/disputes (POST)
app.use('/', require('./routes/payouts')); // /driver/payouts, /driver/earnings, /api/driver/payouts/*

// Driver job board (email-gated)
app.use('/driver', require('./routes/driver'));

// Embeddable widget (page at /embed/quote, API at /api/embed/calculate)
const embed = require('./routes/embed');
app.use('/embed', embed);
app.use('/api/embed', embed);

// Partners (pages at /partners, admin/apply API at /api/partners)
const partners = require('./routes/partners');
app.use('/partners', partners);
app.use('/api/partners', partners);

// Order status + dispatch API
app.use('/api/orders', require('./routes/orders'));

// Referral API
app.use('/api/referral', require('./routes/referral'));

// Driver rating (page at /rate/:id, API at /api/reviews/:id)
const reviews = require('./routes/reviews');
app.use('/rate', reviews);
app.use('/api/reviews', reviews);

// Inbound SMS (Twilio webhook)
app.use('/api/sms', require('./routes/sms'));

// SEO landing pages (mounted at root)
app.use('/', require('./routes/seo'));

// Customer order dashboard
const { getOrdersByEmail } = require('./db/orders');
app.get('/dashboard', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  let orders = [];
  if (email) {
    try {
      orders = await getOrdersByEmail(email);
    } catch (err) {
      console.error('[dashboard] failed to load orders:', err.message);
    }
  }
  res.render('dashboard', { email, orders });
});

// Static informational pages
app.get('/terms', (_req, res) => res.render('terms'));
app.get('/privacy', (_req, res) => res.render('privacy'));
app.get('/cookies', (_req, res) => res.render('cookies'));
app.get('/help', (_req, res) => res.render('help'));
app.get('/notify', (_req, res) => res.render('notify'));

// Home
app.get('/', (req, res) => {
  res.render('layout', { title: 'Shurget - Pickup Truck Delivery' });
});

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ── 404 handler ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404);
  if (req.path.startsWith('/api/')) {
    return res.json({ error: 'Not found' });
  }
  res.render('404');
});

// ── Global error handler ────────────────────────────────────────────────────
// 4-arg signature is required for Express to treat this as an error handler.
app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(err.status || 500);
  if (req.path.startsWith('/api/')) {
    return res.json({ error: 'Internal server error' });
  }
  res.render('error', {
    message: process.env.NODE_ENV === 'production'
      ? 'We encountered an unexpected error. Please try again.'
      : (err.message || 'Internal server error'),
  });
});

app.listen(port, () => {
  console.log(`✅ Shurget server running on port ${port}`);
});
