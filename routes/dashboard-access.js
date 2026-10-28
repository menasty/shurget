// routes/dashboard-access.js — Customer order dashboard behind an email-code
// challenge. The dashboard is keyed by EMAIL, not by order, so a per-order
// token does not fit it. Instead: the customer types their email, gets a
// 6-digit code by email (10-minute expiry), enters it, and receives a signed
// 24-hour dashboard session cookie scoped to that email. No account, no login.
// The old open GET /dashboard?email= lookup is gone: the query param is
// ignored entirely, so an email address alone no longer opens anyone's history.
//
// Stateless code verification (no new table, no migration): at request time
// the server sets a signed commitment cookie,
// dash_commit = signValue(email:expiry:code). The verify step recomputes the
// value from the submitted code and compares in constant time; the code
// itself is never stored. Rate limiting on code verification is a deliberate
// LATER pass (approved spec); brute-force exposure is bounded by the
// 10-minute code expiry in the meantime.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getOrdersByEmail } = require('../db/orders');
const { signValue, unsignValue } = require('../middleware/session');
const { sendDashboardCodeEmail } = require('../services/email');

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours (approved default)
const DASH_SESSION_COOKIE = 'dash_session';
const DASH_COMMIT_COOKIE = 'dash_commit';

function cookieOpts(maxAge) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
  };
}

// Split on the LAST colons so an unusual email containing ':' still parses.
function parseDashSession(cookie) {
  const value = unsignValue(cookie);
  if (!value) return null;
  const sep = value.lastIndexOf(':');
  if (sep === -1) return null;
  const email = value.slice(0, sep);
  const expiry = parseInt(value.slice(sep + 1), 10);
  if (!email || !Number.isFinite(expiry) || expiry <= Date.now()) return null;
  return email;
}

function parseDashCommit(cookie) {
  const value = unsignValue(cookie);
  if (!value) return null;
  const codeSep = value.lastIndexOf(':');
  if (codeSep === -1) return null;
  const code = value.slice(codeSep + 1);
  const rest = value.slice(0, codeSep);
  const expSep = rest.lastIndexOf(':');
  if (expSep === -1) return null;
  const email = rest.slice(0, expSep);
  const expiry = parseInt(rest.slice(expSep + 1), 10);
  if (!email || !Number.isFinite(expiry) || !code) return null;
  return { email, expiry, code };
}

// GET /dashboard — order history for a verified email, or the code form.
router.get('/', async (req, res) => {
  const email = parseDashSession(req.cookies?.[DASH_SESSION_COOKIE]);
  if (!email) {
    return res.render('dashboard', { email: '', orders: [], authed: false, notice: null });
  }
  let orders = [];
  try {
    orders = await getOrdersByEmail(email);
  } catch (err) {
    console.error('[dashboard] failed to load orders:', err.message);
  }
  res.render('dashboard', { email, orders, authed: true, notice: null });
});

// POST /dashboard/request-code — send a code if the email has orders.
// The response is ALWAYS the same generic message, whether or not the email
// exists, so this endpoint cannot be used to test whether an email is a
// customer.
router.post('/request-code', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  let orders = [];
  if (email) {
    try {
      orders = await getOrdersByEmail(email);
    } catch (err) {
      console.error('[dashboard request-code] lookup failed:', err.message);
    }
  }
  if (email && orders.length > 0) {
    const code = String(crypto.randomInt(100000, 1000000));
    const expiry = Date.now() + CODE_TTL_MS;
    res.cookie(DASH_COMMIT_COOKIE, signValue(`${email}:${expiry}:${code}`), cookieOpts(CODE_TTL_MS));
    await sendDashboardCodeEmail(email, code);
  }
  res.render('dashboard', {
    email: '',
    orders: [],
    authed: false,
    notice: 'If that email has orders, a code is on its way. Check your inbox, then enter it below.',
  });
});

// POST /dashboard/verify-code — exchange a matching code for a 24-hour
// dashboard session cookie, then redirect to the order history.
router.post('/verify-code', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const code = (req.body.code || '').trim();
  const commit = parseDashCommit(req.cookies?.[DASH_COMMIT_COOKIE]);
  const codeBuf = Buffer.from(code);
  const expectedBuf = Buffer.from(commit ? commit.code : '');
  const ok =
    !!commit &&
    commit.email === email &&
    commit.expiry > Date.now() &&
    codeBuf.length === expectedBuf.length &&
    crypto.timingSafeEqual(codeBuf, expectedBuf);
  if (!ok) {
    return res.status(401).render('dashboard', {
      email: '',
      orders: [],
      authed: false,
      notice: "That code didn't match or it expired. Request a new code below.",
    });
  }
  res.clearCookie(DASH_COMMIT_COOKIE);
  res.cookie(
    DASH_SESSION_COOKIE,
    signValue(`${email}:${Date.now() + SESSION_TTL_MS}`),
    cookieOpts(SESSION_TTL_MS)
  );
  res.redirect(303, '/dashboard');
});

module.exports = router;
module.exports.parseDashSession = parseDashSession;
module.exports.parseDashCommit = parseDashCommit;
