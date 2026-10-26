// middleware/track-token.js — Gate order-scoped endpoints on a signed token.
// Allows: (a) a valid admin session, so support staff can still open any
// tracking link while helping a customer, or (b) a valid tracking token bound
// to the order id in the URL. Token may arrive as ?token=, JSON body { token },
// or X-Track-Token header. Invalid token -> 403 (never 404: a missing/invalid
// token must not reveal whether the order exists). Order lookup happens only
// AFTER this gate passes, in the route handler.
const { verifyTrackingToken } = require('../services/tracking-token');
const { getSession, unsign, SESSION_COOKIE } = require('./session');

function requireTrackToken(req, res, next) {
  const session = getSession(unsign(req.cookies?.[SESSION_COOKIE]));
  if (session && typeof session.adminEmail === 'string' && session.adminEmail) return next();

  const token = req.query.token || req.body?.token || req.headers['x-track-token'] || '';
  const id = parseInt(req.params.id ?? req.params.orderId, 10);
  const { valid, orderId } = verifyTrackingToken(token);
  if (!valid || orderId !== id) {
    // Inside a router, req.baseUrl is the mount point (/api/orders, /track,
    // /confirmation). API mounts and JSON-accepting clients get JSON; browser
    // page navigations get the expired-link page with a resend form.
    const wantsJson = (req.baseUrl || '').startsWith('/api') || req.accepts('json');
    if (wantsJson) {
      return res.status(403).json({ error: 'This tracking link is invalid or expired.' });
    }
    return res.status(403).render('track-link-expired', {
      orderId: Number.isFinite(id) ? id : '',
      message: 'This tracking link is invalid or expired. Use the link from your booking email or SMS, or request a new one below.',
    });
  }
  req.trackToken = token; // passed through so the page can poll/cancel with it
  next();
}

module.exports = { requireTrackToken };
