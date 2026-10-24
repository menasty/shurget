// middleware/driver-session.js — Driver session store (shared)
// Single source of truth for driver sessions. Previously routes/driver.js
// kept the session Map module-local, so routes/payouts.js and
// routes/disputes.js could not validate sessions server-side and instead
// trusted an unsigned base64 `dr_email` cookie — allowing any driver to
// impersonate any other driver. All driver modules now share this store.
const crypto = require('crypto');

const DRIVER_SESSIONS = new Map(); // sessionId -> { driverId, email, createdAt }
const DRIVER_COOKIE = 'dr_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

function signId(id) {
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(id);
  return id + '.' + hmac.digest('base64url');
}

function unsignId(cookie) {
  if (!cookie || typeof cookie !== 'string') return null;
  const dot = cookie.lastIndexOf('.');
  if (dot === -1) return null;
  const id = cookie.slice(0, dot);
  const sig = cookie.slice(dot + 1);
  const expected = signId(id).split('.').pop();
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
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

function destroyDriverSession(sessionId) {
  DRIVER_SESSIONS.delete(sessionId);
}

function setDriverCookie(res, sessionId) {
  res.cookie(DRIVER_COOKIE, signId(sessionId), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_MS,
  });
}

// Express middleware: resolves the driver from the server-side session.
// Identity NEVER comes from client-supplied data (cookies, body, query).
async function requireDriverSession(req, res, next) {
  const { getDriverByEmail } = require('../db/drivers');
  const sess = getDriverSession(req.cookies?.[DRIVER_COOKIE]);
  if (!sess) return res.redirect('/driver/login');

  const driver = await getDriverByEmail(sess.email).catch(() => null);
  if (!driver) {
    res.clearCookie(DRIVER_COOKIE);
    return res.redirect('/driver/login');
  }

  req.driver = driver;
  req.driverSess = sess;
  next();
}

module.exports = {
  DRIVER_COOKIE,
  SESSION_TTL_MS,
  signId,
  unsignId,
  createDriverSession,
  getDriverSession,
  destroyDriverSession,
  setDriverCookie,
  requireDriverSession,
};
