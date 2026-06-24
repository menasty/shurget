// services/rating-token.js — One-time rating token for post-delivery review links
// Owns: generating and verifying signed tokens for the rate-driver page
// Does NOT own: database writes, email sending

const crypto = require('crypto');

// Secret key for HMAC — falls back to a static dev key; MUST be set in prod via env var.
function getSecret() {
  return process.env.RATING_TOKEN_SECRET || 'haulr-dev-rating-token-secret-change-in-prod';
}

const TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60; // 14 days

/**
 * Generate a signed rating token for an order.
 * Format: base64url( orderId:expiresAt:hmac )
 * The token is single-use enforced by the DB unique index on driver_ratings(order_id).
 */
function generateRatingToken(orderId) {
  const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS;
  const payload = `${orderId}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  const raw = `${payload}:${hmac}`;
  return Buffer.from(raw).toString('base64url');
}

/**
 * Verify a rating token. Returns { orderId, valid } where valid=false means expired or tampered.
 */
function verifyRatingToken(token) {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const parts = raw.split(':');
    if (parts.length !== 3) return { orderId: null, valid: false };

    const [orderId, expiresAt, providedHmac] = parts;
    const payload = `${orderId}:${expiresAt}`;
    const expectedHmac = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');

    // Constant-time comparison to prevent timing attacks
    const valid =
      crypto.timingSafeEqual(Buffer.from(providedHmac, 'hex'), Buffer.from(expectedHmac, 'hex')) &&
      parseInt(expiresAt, 10) > Math.floor(Date.now() / 1000);

    return { orderId: valid ? parseInt(orderId, 10) : null, valid };
  } catch {
    return { orderId: null, valid: false };
  }
}

module.exports = { generateRatingToken, verifyRatingToken };
