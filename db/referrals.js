// db/referrals.js — Referral code CRUD and redemption queries
// Owns: referral_codes + referral_redemptions table access
// Does NOT own: code generation logic, email sending, Stripe discount application

const db = require('./index');
const crypto = require('crypto');

/** Generate a random 8-char alphanumeric code (uppercase). */
function generateCode() {
  return crypto.randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8).padEnd(8, '0');
}

/**
 * Get referral code for an email. Returns null if none exists.
 */
async function getReferralCodeByEmail(email) {
  const { rows } = await db.query(
    'SELECT * FROM referral_codes WHERE owner_email = $1 ORDER BY created_at ASC LIMIT 1',
    [email.toLowerCase().trim()]
  );
  return rows[0] || null;
}

/**
 * Get referral code by code string.
 */
async function getReferralCodeByCode(code) {
  const { rows } = await db.query(
    'SELECT * FROM referral_codes WHERE code = $1',
    [code.toUpperCase().trim()]
  );
  return rows[0] || null;
}

/**
 * Create a referral code for an email if one doesn't already exist.
 * Returns the existing or newly created code row.
 */
async function getOrCreateReferralCode(email) {
  const normalizedEmail = email.toLowerCase().trim();
  const existing = await getReferralCodeByEmail(normalizedEmail);
  if (existing) return existing;

  // Try up to 5 times to generate a unique code
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      const { rows } = await db.query(
        'INSERT INTO referral_codes (code, owner_email) VALUES ($1, $2) RETURNING *',
        [code, normalizedEmail]
      );
      return rows[0];
    } catch (err) {
      // Unique violation on code — try again
      if (err.code === '23505') continue;
      throw err;
    }
  }
  throw new Error('Failed to generate unique referral code after 5 attempts');
}

/**
 * Record a referral code redemption and increment the code's use_count.
 * Returns the redemption row.
 */
async function recordRedemption(codeId, refereeEmail, orderId, creditAmount = 2000) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO referral_redemptions (code_id, referee_email, order_id, credit_amount)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [codeId, refereeEmail ? refereeEmail.toLowerCase().trim() : null, orderId, creditAmount]
    );
    await client.query(
      'UPDATE referral_codes SET use_count = use_count + 1 WHERE id = $1',
      [codeId]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get referral stats for a customer email.
 * Returns { code, referredCount, totalCreditEarned }
 */
async function getReferralStats(email) {
  const code = await getReferralCodeByEmail(email);
  if (!code) return { code: null, referredCount: 0, totalCreditEarned: 0 };

  const { rows } = await db.query(
    `SELECT COUNT(*) AS referred_count,
            COALESCE(SUM(credit_amount), 0) AS total_credit
     FROM referral_redemptions
     WHERE code_id = $1`,
    [code.id]
  );

  return {
    code,
    referredCount: parseInt(rows[0].referred_count, 10),
    totalCreditEarned: parseInt(rows[0].total_credit, 10),
  };
}

/**
 * Check if a referral redemption already exists for this order (idempotency).
 */
async function getRedemptionByOrderId(orderId) {
  const { rows } = await db.query(
    'SELECT * FROM referral_redemptions WHERE order_id = $1 LIMIT 1',
    [orderId]
  );
  return rows[0] || null;
}

/**
 * Create a single-use $20 credit referral code for a referrer.
 * max_uses = 1 makes it single-use (the owner can use it once).
 * Returns the new code string, or null on failure.
 */
async function createSingleUseCreditCode(ownerEmail) {
  for (let i = 0; i < 5; i++) {
    const candidate = crypto.randomBytes(6).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8).padEnd(8, '0');
    try {
      const { rows } = await db.query(
        'INSERT INTO referral_codes (code, owner_email, max_uses) VALUES ($1, $2, 1) RETURNING *',
        [candidate, ownerEmail.toLowerCase().trim()]
      );
      return rows[0].code;
    } catch (err) {
      if (err.code === '23505') continue; // unique collision, retry
      throw err;
    }
  }
  return null; // Failed after retries
}

module.exports = {
  getReferralCodeByEmail,
  getReferralCodeByCode,
  getOrCreateReferralCode,
  recordRedemption,
  getReferralStats,
  getRedemptionByOrderId,
  createSingleUseCreditCode,
};
