// services/tracking-token.js — Signed, expiring tokens for customer tracking links.
// Mirrors services/rating-token.js. Stateless: no DB migration, no stored tokens.
// A token is a bearer capability for ONE order: anyone holding a valid link can
// view that order until expiry. That is the same trust model as today's emailed
// link, minus guessability — sequential order IDs alone no longer open an order.
const crypto = require('crypto');

// 30 days (approved default). Shorter is safer; longer is friendlier for
// customers who revisit a delivered order.
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function getSecret() {
  const secret = process.env.TRACKING_TOKEN_SECRET;
  if (!secret && process.env.NODE_ENV === 'production') {
    throw new Error('TRACKING_TOKEN_SECRET must be set in production');
  }
  return secret || 'Shurget-dev-tracking-token-secret-change-in-prod';
}

// Fail closed at boot in production: a deploy without the secret must crash
// instead of serving links signed with the dev fallback. Set
// TRACKING_TOKEN_SECRET in the Render dashboard before deploying this code.
if (process.env.NODE_ENV === 'production' && !process.env.TRACKING_TOKEN_SECRET) {
  throw new Error('TRACKING_TOKEN_SECRET must be set in production');
}

// Format: base64url( orderId:expiresAt:track:hmac )
function generateTrackingToken(orderId) {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${orderId}:${expiresAt}:track`;
  const hmac = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  return Buffer.from(`${payload}:${hmac}`).toString('base64url');
}

// Verify a tracking token. Returns { orderId, valid } where valid=false means
// expired, tampered, wrong purpose, or malformed. Never throws.
function verifyTrackingToken(token) {
  try {
    if (!token || typeof token !== 'string') return { orderId: null, valid: false };
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length !== 4) return { orderId: null, valid: false };
    const [orderId, expiresAt, purpose, providedHmac] = parts;
    if (purpose !== 'track') return { orderId: null, valid: false };
    const payload = `${orderId}:${expiresAt}:track`;
    const expectedHmac = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
    const providedBuf = Buffer.from(providedHmac, 'hex');
    const expectedBuf = Buffer.from(expectedHmac, 'hex');

    // Constant-time comparison; length check first because timingSafeEqual
    // throws on unequal lengths.
    const valid =
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf) &&
      parseInt(expiresAt, 10) > Math.floor(Date.now() / 1000);

    return { orderId: valid ? parseInt(orderId, 10) : null, valid };
  } catch {
    return { orderId: null, valid: false };
  }
}

module.exports = { generateTrackingToken, verifyTrackingToken, TOKEN_TTL_SECONDS };
