// middleware/session.js — Admin session auth
// Simple signed-cookie sessions using Node.js crypto. No external deps.
// Session data stored in memory (resets on app restart — fine for single-instance admin).
const crypto = require('crypto');
const sessions = new Map(); // sessionId -> { createdAt, adminEmail }
const partnerSessions = new Map(); // sessionId -> { createdAt, partnerId, partnerEmail }

const SESSION_COOKIE = 'ha_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const PARTNER_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

function signSession(sessionId) {
  const hmac = crypto.createHmac('sha256', COOKIE_SECRET);
  hmac.update(sessionId);
  return sessionId + '.' + hmac.digest('base64url');
}

// Sign an arbitrary value (e.g. a magic-link payload). The value may itself
// contain '.' characters (emails do), so verification splits on the LAST '.'.
function signValue(value) {
  return signSession(value);
}

function unsignValue(signed) {
  if (!signed || typeof signed !== 'string') return null;
  const dot = signed.lastIndexOf('.');
  if (dot === -1) return null;
  const value = signed.slice(0, dot);
  const sig = signed.slice(dot + 1);
  const expected = signSession(value).split('.').pop();
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  return value;
}

function unsign(cookie) {
  return unsignValue(cookie);
}

function createSession(adminEmail) {
  const id = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { createdAt: Date.now(), adminEmail });
  return id;
}

function destroySession(sessionId) {
  sessions.delete(sessionId);
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const sess = sessions.get(sessionId);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return sess;
}

// ─── Partner sessions (separate store — partner sessions must NEVER be
// valid admin sessions, so they live in their own Map) ──────────────────────
function createPartnerSession({ partnerId, partnerEmail }) {
  const id = crypto.randomBytes(32).toString('base64url');
  partnerSessions.set(id, { createdAt: Date.now(), partnerId, partnerEmail, type: 'partner' });
  return id;
}

function getPartnerSession(sessionId) {
  if (!sessionId) return null;
  const sess = partnerSessions.get(sessionId);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > PARTNER_SESSION_TTL_MS) {
    partnerSessions.delete(sessionId);
    return null;
  }
  return sess;
}

function destroyPartnerSession(sessionId) {
  partnerSessions.delete(sessionId);
}

function validateCredentials(username, password) {
  const adminUser = process.env.ADMIN_USERNAME;
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminUser || !adminPass) return false;
  return username === adminUser && password === adminPass;
}

function requireAdmin(req, res, next) {
  const cookie = req.cookies?.[SESSION_COOKIE];
  const sessionId = unsign(cookie);
  const session = getSession(sessionId);

  // Admin sessions are only ever created by the admin login with a string
  // email. Anything else in the store (wrong type, missing email) is not an
  // admin session.
  if (!session || typeof session.adminEmail !== 'string' || !session.adminEmail) {
    // API routes get a 401; page routes get a redirect
    if (req.path.startsWith('/api/') || req.baseUrl.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/admin/login');
  }

  req.adminEmail = session.adminEmail;
  next();
}

// Same check as requireAdmin, but always answers 401 JSON (for API routers
// where req.path is router-relative and never starts with /api/).
function requireAdminApi(req, res, next) {
  const cookie = req.cookies?.[SESSION_COOKIE];
  const sessionId = unsign(cookie);
  const session = getSession(sessionId);

  if (!session || typeof session.adminEmail !== 'string' || !session.adminEmail) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.adminEmail = session.adminEmail;
  next();
}

module.exports = {
  SESSION_COOKIE,
  createSession,
  destroySession,
  getSession,
  createPartnerSession,
  getPartnerSession,
  destroyPartnerSession,
  signSession,
  signValue,
  unsign,
  unsignValue,
  validateCredentials,
  requireAdmin,
  requireAdminApi,
};
