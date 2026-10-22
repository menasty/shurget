// routes/partners.js — Partners landing page, apply form, apply API, dashboard
// Owns: GET /partners, /partners/apply, /partners/:slug, /partners/:slug/setup
// Owns: POST /api/partners/apply, /api/partners/:id/approve
// Does NOT own: Stripe Connect (services/stripe-connect.js), email sending (services/email.js)

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const {
  createPartnerLead,
} = require('../db/quote_requests');
const {
  createPartnerApplication,
  getPendingApplications,
  getAllApplications,
  updateApplicationStatus,
  createPartner,
  getPartnerBySlug,
  getAllPartners,
  getPartnerStats,
  updatePartnerStripeAccount,
} = require('../db/partners');
const {
  sendPartnerLeadEmail,
  sendPartnerApplicationReceived,
} = require('../services/email');
const {
  sendStripeAccountLinkEmail,
} = require('../services/stripe-connect');
const {
  createPartnerSession,
  getPartnerSession,
  destroyPartnerSession,
  unsign,
  signSession,
  signValue,
  unsignValue,
  requireAdmin,
} = require('../middleware/session');

// ─── Session helper ───────────────────────────────────────────────────────────

function loadPartnerSession(req) {
  const raw = (req.headers['cookie'] || '').split(';').reduce((acc, pair) => {
    const idx = pair.indexOf('=');
    if (idx > 0) acc[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1));
    return acc;
  }, {});
  const signed = raw['shurget_partner_session'];
  if (!signed) return null;
  const id = unsign(signed);
  if (!id) return null;
  // Partner sessions live in their own store (middleware/session.js) — a
  // partner session id is meaningless to the admin session store.
  const sess = getPartnerSession(id);
  if (!sess || !sess.partnerId) return null;
  return sess;
}

function setPartnerSession(res, sessionId) {
  const signed = signSession(sessionId);
  res.setHeader('Set-Cookie',
    `shurget_partner_session=${signed}; HttpOnly; SameSite=Lax; Max-Age=86400; Path=/`);
}

// ─── Public pages ─────────────────────────────────────────────────────────────

/** GET /partners — render partners landing page */
router.get('/', (_req, res) => {
  res.render('partners');
});

/** GET /partners/embed — live widget demo + snippet generator */
router.get('/embed', (_req, res) => {
  res.render('partners-embed');
});

/** GET /partners/integration-kit — technical integration kit page for partners */
router.get('/integration-kit', (_req, res) => {
  res.render('partners-integration-kit');
});

/** GET /partners/b2b-pilot-kit — retailer-facing B2B pilot program page */
router.get('/b2b-pilot-kit', (_req, res) => {
  res.render('partners-b2b-pilot-kit');
});

/** GET /partners/pilot-kit — shareable B2B pilot kit for Denver retailer outreach */
router.get('/pilot-kit', (_req, res) => {
  res.render('partners/pilot-kit');
});

/** GET /partners/apply — new partner application form */
router.get('/apply', (_req, res) => {
  res.render('partner-apply');
});

// ─── Apply flow ──────────────────────────────────────────────────────────────

/** POST /api/partners/apply — submit partner application → auto-reply email */
router.post('/apply', async (req, res) => {
  const { store_name, website_url, contact_name, contact_email, contact_phone, monthly_volume, zip_codes_served, item_description } = req.body;

  if (!store_name || !contact_name || !contact_email || !monthly_volume) {
    return res.status(400).json({ error: 'Store name, contact name, contact email, and monthly volume are required.' });
  }

  const cleanEmail = (contact_email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  try {
    const app = await createPartnerApplication({
      storeName:       store_name,
      websiteUrl:      website_url,
      contactName:     contact_name,
      contactEmail:    cleanEmail,
      contactPhone:    contact_phone,
      monthlyVolume:   monthly_volume,
      zipCodesServed:  zip_codes_served,
      itemDescription: item_description,
    });

    // Auto-reply email
    sendPartnerApplicationReceived(app).catch(err => {
      console.error('[partners] Failed to send auto-reply email:', err.message);
    });

    return res.status(201).json({
      success: true,
      message: "Thanks! We've received your application and will be in touch within 48 hours.",
      id: app.id,
    });
  } catch (err) {
    console.error('[partners/apply] Error saving application:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

/** POST /api/partners/lead — submit B2B pilot kit contact form */
router.post('/lead', async (req, res) => {
  const { company_name, name, email, phone, monthly_volume, zip_codes_served, item_description } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  if (!/^[^\n@\s]+@[^\n@\s]+\.[^\n@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }

  try {
    const lead = await createPartnerLead({
      name,
      email,
      phone:     phone || null,
      monthlyVolume:  monthly_volume || null,
      zipCodesServed:  zip_codes_served || null,
      itemDescription: item_description || null,
      companyName: company_name || null,
    });

    sendPartnerLeadEmail(lead).catch(err => {
      console.error('[partners/lead] Failed to send lead notification:', err.message);
    });

    return res.status(201).json({
      success: true,
      message: "Thanks! We'll be in touch within 1 business day.",
      id: lead.id,
    });
  } catch (err) {
    console.error('[partners/lead] Error saving lead:', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ─── Partner dashboard (auth-gated) ──────────────────────────────────────────

/** GET /partners/:slug — partner dashboard (login required) */
router.get('/:slug', async (req, res) => {
  const { slug } = req.params;
  const sess = loadPartnerSession(req);
  const partner = await getPartnerBySlug(slug);

  if (!partner) return res.status(404).render('404');

  if (!sess || sess.partnerId !== partner.id) {
    // Not logged in — show email prompt
    return res.render('partner-login', { partner, error: null });
  }

  // Load stats + recent orders. Wrapped so a data error renders an error
  // page instead of an unhandled rejection that takes the process down.
  try {
    const stats = await getPartnerStats(slug);

    const { getOrdersByPartner } = require('../db/orders');
    const orders = await getOrdersByPartner(slug);

    return res.render('partner-dashboard', { partner, stats, orders });
  } catch (err) {
    console.error('[partners] dashboard failed for', slug, err.message);
    return res.status(500).render('error', { message: 'Could not load your dashboard. Please try again.' });
  }
});

/** POST /partners/:slug/login — magic link email login */
router.post('/:slug/login', async (req, res) => {
  const { slug } = req.params;
  const { email } = req.body;
  const partner = await getPartnerBySlug(slug);

  if (!partner) return res.status(404).render('404');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.render('partner-login', { partner, error: 'Enter a valid email address.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail !== partner.contact_email) {
    return res.render('partner-login', { partner, error: 'No account found for that email. Contact support@shurget.com.' });
  }

  // Generate magic link: signed token with partnerId + email + issued-at (24h expiry)
  const token = signValue(crypto.randomBytes(16).toString('hex') + ':' + partner.id + ':' + cleanEmail + ':' + Date.now());
  const magicLink = `${req.protocol}://${req.get('host')}/partners/${slug}/verify?token=${encodeURIComponent(token)}`;

  // Send magic link email
  const { sendPartnerMagicLink } = require('../services/email');
  sendPartnerMagicLink(partner, magicLink).catch(err => {
    console.error('[partners] Failed to send magic link:', err.message);
  });

  // Always show success (don't reveal whether email matched)
  return res.render('partner-magic-sent', { partner, email: cleanEmail });
});

/** GET /partners/:slug/verify — magic link handler → set session */
router.get('/:slug/verify', async (req, res) => {
  const { slug } = req.params;
  const magicToken = req.query.token;
  const partner = await getPartnerBySlug(slug);

  if (!partner || !magicToken) return res.status(400).send('This sign-in link is invalid.');

  // Actually verify the magic token: it must carry a valid HMAC signature
  // (unsignValue returns the payload only when the signature checks out),
  // name THIS partner and their contact email, and be under 24h old.
  // (Previously the token was never checked at all — any non-empty value
  // minted a session, in the admin session store.)
  const payload = unsignValue(magicToken);
  const parts = payload ? payload.split(':') : [];
  const tokenPartnerId = parts.length === 4 ? parseInt(parts[1], 10) : NaN;
  const tokenEmail = parts.length === 4 ? parts[2] : null;
  const issuedAt = parts.length === 4 ? parseInt(parts[3], 10) : NaN;
  const MAX_TOKEN_AGE_MS = 24 * 60 * 60 * 1000;

  if (
    tokenPartnerId !== partner.id ||
    tokenEmail !== partner.contact_email ||
    !Number.isFinite(issuedAt) ||
    Date.now() - issuedAt > MAX_TOKEN_AGE_MS
  ) {
    return res.status(400).send('This sign-in link is invalid or has expired. Request a new one.');
  }

  const sessionId = createPartnerSession({ partnerId: partner.id, partnerEmail: partner.contact_email });
  setPartnerSession(res, sessionId);

  return res.redirect(`/partners/${slug}`);
});

/** POST /partners/:slug/logout — clear partner session */
router.post('/:slug/logout', (req, res) => {
  const sess = loadPartnerSession(req);
  if (sess) {
    const signed = (req.headers['cookie'] || '').split(';').map(s => s.trim())
      .find(s => s.startsWith('shurget_partner_session='));
    if (signed) {
      const id = unsign(decodeURIComponent(signed.slice('shurget_partner_session='.length)));
      if (id) destroyPartnerSession(id);
    }
  }
  res.setHeader('Set-Cookie',
    'shurget_partner_session=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/');
  return res.redirect(`/signed-out?who=partner&slug=${encodeURIComponent(req.params.slug)}`);
});

// ─── Admin: approve/reject applications ──────────────────────────────────────

/** POST /api/partners/:id/approve — admin approves application → creates partner + sends setup email */
router.post('/:id/approve', requireAdmin, async (req, res) => {
  const appId = parseInt(req.params.id, 10);
  if (isNaN(appId)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const app = await updateApplicationStatus(appId, 'approved', req.adminEmail);
    if (!app) return res.status(404).json({ error: 'Application not found' });

    // Create the partner record
    const partner = await createPartner({
      storeName:    app.store_name,
      websiteUrl:   app.website_url,
      contactEmail: app.contact_email,
    });

    // Send setup email with Stripe Connect onboarding
    sendPartnerSetupEmail(partner, app).catch(err => {
      console.error('[partners/approve] Failed to send setup email:', err.message);
    });

    return res.json({ success: true, partner });
  } catch (err) {
    console.error('[partners/approve]', err);
    return res.status(500).json({ error: 'Failed to approve application' });
  }
});

/** POST /api/partners/:id/reject — admin rejects application */
router.post('/:id/reject', requireAdmin, async (req, res) => {
  const appId = parseInt(req.params.id, 10);
  if (isNaN(appId)) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const app = await updateApplicationStatus(appId, 'rejected', req.adminEmail);
    return res.json({ success: true, application: app });
  } catch (err) {
    console.error('[partners/reject]', err);
    return res.status(500).json({ error: 'Failed to reject application' });
  }
});

module.exports = router;

// ─── Stripe Connect onboarding ───────────────────────────────────────────────

/** GET /partners/:slug/setup — initiate or refresh Stripe Connect onboarding */
router.get('/:slug/setup', async (req, res) => {
  const sess = loadPartnerSession(req);
  const partner = await getPartnerBySlug(req.params.slug);

  if (!partner) return res.status(404).render('404');
  if (!sess || sess.partnerId !== partner.id) return res.redirect(`/partners/${req.params.slug}`);

  const host = `${req.protocol}://${req.get('host')}`;
  const refreshUrl = `${host}/partners/${partner.slug}/setup`;
  const returnUrl  = `${host}/partners/${partner.slug}`;

  const { createPartnerConnectAccount, createPartnerAccountLink } = require('../services/stripe-connect');

  let accountId = partner.stripe_account_id;
  if (!accountId) {
    const account = await createPartnerConnectAccount(partner);
    accountId = account.id;
    await updatePartnerStripeAccount(partner.id, accountId);
  }

  const link = await createPartnerAccountLink(accountId, { refreshUrl, returnUrl });
  return res.redirect(link.url);
});

async function sendPartnerSetupEmail(partner, application) {
  const { sendPartnerApplicationReceived } = require('../services/email');
  return sendPartnerApplicationReceived({ ...application, partnerSlug: partner.slug });
}